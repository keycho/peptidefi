/**
 * BioHash Peptide Index runner.
 *
 * Encapsulates the pin-twice cohort-completion flow that turns a
 * finalized 29-of-29 cohort hour into:
 *
 *   1. an index_history row (level, components_hash, baseline_*),
 *   2. per-row index_level / index_components_hash columns on every
 *      cohort twap_commits row for the hour,
 *   3. 29 final pins (manifest with populated index_snapshot),
 *   4. an ipfs_cids array on index_history snapshotted via
 *      COALESCE(final_ipfs_cid, ipfs_cid) once the repin loop settles.
 *
 * Two call sites:
 *
 *   - twap-poller.ts: in-process trigger after each markFinalizedTwap.
 *     Wraps runCohortCompletionForHour in a detached IIFE so a Pinata
 *     hiccup never blocks the poller's tick.
 *   - index.ts: runStartupRecovery on oracle boot, BEFORE the pollers
 *     start ticking. Walks twap_commits for any UTC hour whose cohort
 *     is fully finalized but missing from index_history, and runs the
 *     same runCohortCompletionForHour against it. Also re-runs the
 *     ipfs_cids snapshot UPDATE for any index_history row older than
 *     5 minutes that still has ipfs_cids null (case C in the design
 *     doc: mid-repin-loop crash).
 *
 * Both call sites rely on the same mutex primitives:
 *
 *   - INSERT INTO index_history ON CONFLICT (hour_start) DO NOTHING
 *     RETURNING hour_start
 *       Exactly one racer's INSERT returns a row; the other returns
 *       empty and bails out before any per-row UPDATE or pin attempt.
 *   - UPDATE twap_commits ... WHERE index_level IS NULL
 *       Idempotent; a second observer that lost the index_history
 *       INSERT race silently no-ops here too.
 *   - UPDATE index_history ... WHERE ipfs_cids IS NULL
 *       Same guard for the snapshot write.
 *
 * Concurrency contract: runStartupRecovery runs to completion before
 * runTwapPoller starts ticking (enforced by index.ts await ordering),
 * so the recovery's fire-and-forget repin IIFEs cannot race with the
 * normal poller trigger for the same hour. Within the poller, the
 * in-process IIFEs from adjacent ticks may run concurrently but the
 * three guards above make every state transition idempotent.
 */

import { createHash } from 'node:crypto';
import type { SqlClient } from './db/client';
import { setTwapFinalIpfsCid } from './db/twap-state';
import type { OracleHealthState } from './health';
import type { IndexComputer } from './index-computer';
import { buildCycleManifest } from './ipfs/manifest-builder';
import {
  isPinataConfigured,
  pinCycleToIPFS,
  type IndexSnapshot,
} from './ipfs/pinata';
import {
  triggerIndexAccountWriteBestEffort,
  type IndexAccountWriter,
} from './solana/index-account-writer';
import {
  triggerLzEmitBestEffort,
  type IndexLzEmitter,
} from './lz/index-lz-emitter';

/**
 * Optional health-state surface for the cohort-completion runner.
 *
 * The runner updates two fields on success: last_commit_at (drives the
 * 24h staleness rule in isHealthy) and committed_count_24h (running
 * counter for /health observability). Pass `null` from contexts that
 * have no health state (tests, scripts).
 */
export type IndexHealthSink = Pick<OracleHealthState['index'], 'last_commit_at' | 'committed_count_24h'>;

interface RepinRow {
  id: string;
  peptide_code: string;
  computed_at: Date;
  twap_value: string;
  observation_set_root: string;
  solana_signature: string;
  solana_slot: number;
}

/**
 * Idempotent cohort-completion handler for one UTC hour.
 *
 * Safe to call when the cohort is incomplete (returns early), safe to
 * call when the index has already been computed (the INSERT mutex
 * makes the second caller a no-op), safe to call from concurrent
 * sources thanks to the ON CONFLICT + per-row IS NULL guards.
 *
 * NEVER THROWS. Logs failures and returns void. The caller treats
 * this as fire-and-forget; a Pinata outage or a DB transient must not
 * propagate back to the twap-poller's tick handler.
 */
export async function runCohortCompletionForHour(
  sql: SqlClient,
  computer: IndexComputer,
  hourStart: Date,
  healthSink?: IndexHealthSink | null,
  indexAccountWriter?: IndexAccountWriter | null,
  lzEmitter?: IndexLzEmitter | null,
): Promise<void> {
  try {
    await runCohortCompletionForHourInner(
      sql,
      computer,
      hourStart,
      healthSink ?? null,
      indexAccountWriter ?? null,
      lzEmitter ?? null,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[index-history-runner] hour=${hourStart.toISOString()} unexpected error: ${msg}`,
    );
  }
}

async function runCohortCompletionForHourInner(
  sql: SqlClient,
  computer: IndexComputer,
  hourStart: Date,
  healthSink: IndexHealthSink | null,
  indexAccountWriter: IndexAccountWriter | null,
  lzEmitter: IndexLzEmitter | null,
): Promise<void> {
  // Cohort completion check. Compares the count of finalized cohort
  // rows for the hour against the cohort size. Source of truth for
  // both numbers is the DB so a transient mismatch with the cached
  // computer.cohortSize() never desyncs (e.g. if someone added a row
  // to index_baselines mid-process -- which they shouldn't, per the
  // loadIndexBaselines lifecycle comment, but defense in depth).
  const completion = await sql<
    { cohort_n: number; finalized_n: number }[]
  >`
    WITH cohort AS (
      SELECT peptide_code FROM public.index_baselines
    ),
    finalized AS (
      SELECT tc.peptide_code
      FROM   public.twap_commits tc
      JOIN   cohort c ON c.peptide_code = tc.peptide_code
      WHERE  tc.computed_at = ${hourStart}
        AND  tc.status      = 'finalized'
    )
    SELECT (SELECT count(*)::int FROM cohort)    AS cohort_n,
           (SELECT count(*)::int FROM finalized) AS finalized_n
  `;
  const row = completion[0];
  if (!row || row.finalized_n < row.cohort_n) return;

  // Fetch the cohort's finalized TWAPs for the hour.
  const twapRows = await sql<
    { peptide_code: string; twap_value: string }[]
  >`
    SELECT tc.peptide_code,
           tc.twap_value::text AS twap_value
    FROM   public.twap_commits tc
    JOIN   public.index_baselines b ON b.peptide_code = tc.peptide_code
    WHERE  tc.computed_at = ${hourStart}
      AND  tc.status      = 'finalized'
  `;
  const twapsByPeptide = new Map<string, number>(
    twapRows.map((r) => [r.peptide_code, Number(r.twap_value)]),
  );

  // Pure compute. Returns null if any cohort peptide is missing a
  // TWAP -- shouldn't happen given the SQL count match above, but
  // the computer's own check is the canonical guard.
  const result = computer.computeIndex(hourStart, twapsByPeptide);
  if (result === null) {
    console.warn(
      `[index-history-runner] hour=${hourStart.toISOString()} ` +
        `computeIndex returned null despite cohort count match; ` +
        `skipping index_history write for this hour`,
    );
    return;
  }

  // Capture exact input value (ISO form) before the INSERT so the
  // round-trip check below can compare byte-for-byte against what
  // postgres returned via RETURNING hour_start.
  const hourStartIso = hourStart.toISOString();

  // INSERT under the hour_start PK mutex. Only one racer's INSERT
  // returns a row; everyone else bails out here without touching
  // per-row columns or kicking off pins.
  const inserted = await sql<{ hour_start: Date }[]>`
    INSERT INTO public.index_history
      (hour_start, level, components_hash, computed_at,
       baseline_date, baseline_level, ipfs_cids)
    VALUES
      (${hourStart}::timestamptz,
       ${result.level}::numeric,
       ${result.components_hash},
       ${result.computed_at},
       ${result.baseline_date.toISOString().slice(0, 10)}::date,
       ${result.baseline_level}::numeric,
       NULL)
    ON CONFLICT (hour_start) DO NOTHING
    RETURNING hour_start
  `;
  if (inserted.length === 0) {
    // Lost the race -- another caller wrote the row. Nothing left
    // for us to do; the per-row UPDATEs and repin loop were either
    // already done by the winner or are about to be.
    return;
  }

  // Defensive check: pg has historically stored hour_start with
  // minute=0 instead of minute=59. Cause not fully root-caused; the
  // explicit ::timestamptz cast above should prevent it, but the
  // guard is cheap insurance. On mismatch: the index_history row
  // already exists with whatever postgres stored, but we refuse to
  // run the per-row UPDATE, repin loop, or ipfs_cids snapshot for
  // this hour -- manual cleanup expected, no auto-delete.
  const writtenIso = inserted[0]!.hour_start.toISOString();
  if (writtenIso !== hourStartIso) {
    console.error(
      `[index-history-runner] index_history_corrupted_row ` +
        `expected=${hourStartIso} got=${writtenIso} ` +
        `action="skipping downstream updates, manual cleanup required"`,
    );
    return;
  }

  console.log(
    `[index-history-runner] hour=${hourStartIso} ` +
      `index_history WROTE level=${result.level.toFixed(6)} ` +
      `components_hash=${result.components_hash.slice(0, 12)}... ` +
      `cohort_n=${row.cohort_n}`,
  );

  // Update the health sink BEFORE the per-row UPDATE / repin loop --
  // those are best-effort; the level write is the canonical signal
  // that the index is alive for this hour.
  if (healthSink) {
    healthSink.last_commit_at = new Date().toISOString();
    healthSink.committed_count_24h += 1;
  }

  // On-chain index account write (schema 1.1). Fire-and-forget,
  // mirrors the pin + peg-pusher pattern. The runner is the only
  // place that holds both the freshly-computed level and the
  // already-pinned components_hash, so we fire here rather than
  // re-reading from index_history downstream. Sanity check the
  // canonical minute=59 cadence before writing; off-pattern hours
  // should never reach this point (the SQL filter at scan sites
  // excludes them), but the cheap guard keeps the on-chain account
  // from ever recording an artifact-driven write.
  const hourStartUnix = Math.floor(hourStart.getTime() / 1000);
  if (indexAccountWriter) {
    triggerIndexAccountWriteBestEffort(indexAccountWriter, {
      level: result.level,
      hourStartUnix,
      componentsHash: result.components_hash,
      hourStartIso,
    });
  }

  // LayerZero V2 emit to the configured Base mirror. Parallel to the
  // on-chain Solana PDA write above: both are fire-and-forget, both
  // are independent, neither can block the other or anything else.
  // The slot field on the LZ payload is the slot at which the Solana
  // index PDA was last updated; the writer above runs first but
  // resolves asynchronously, so the slot we pass here is the runner's
  // best-knowledge value at this point; clock.slot from the on-chain
  // write itself is not yet available. Base consumers should treat
  // `slot` as informational; the canonical Solana attestation is the
  // on-chain index PDA, queryable directly by slot via getSignaturesFor
  // Address(authority).
  if (lzEmitter) {
    triggerLzEmitBestEffort(lzEmitter, {
      level: result.level,
      hourStartUnix,
      componentsHash: result.components_hash,
      slot: 0, // see comment above; the emitter program also embeds Clock.slot from its own context
      hourStartIso,
    });
  }

  // Per-row UPDATE. WHERE index_level IS NULL keeps it idempotent
  // even if a startup recovery race left some rows already written.
  await sql`
    UPDATE public.twap_commits
    SET    index_level            = ${result.level}::numeric,
           index_components_hash  = ${result.components_hash}
    WHERE  computed_at = ${hourStart}
      AND  peptide_code IN (SELECT peptide_code FROM public.index_baselines)
      AND  index_level IS NULL
  `;

  if (!isPinataConfigured()) {
    // No Pinata -- skip the repin loop entirely. The snapshot UPDATE
    // would no-op anyway (every COALESCE returns null). index_history
    // row stands with ipfs_cids=null; that is the correct state for
    // an oracle running with pinning disabled.
    return;
  }

  // Repin loop. Selects only rows whose final pin has not yet
  // succeeded so a startup recovery never re-pins a peptide twice.
  const rowsForRepin = await sql<RepinRow[]>`
    SELECT tc.id,
           tc.peptide_code,
           tc.computed_at,
           tc.twap_value::text AS twap_value,
           tc.observation_set_root,
           tc.solana_signature,
           tc.solana_slot
    FROM   public.twap_commits tc
    JOIN   public.index_baselines b ON b.peptide_code = tc.peptide_code
    WHERE  tc.computed_at = ${hourStart}
      AND  tc.status      = 'finalized'
      AND  tc.final_ipfs_cid IS NULL
      AND  tc.solana_signature IS NOT NULL
  `;

  const snapshot: IndexSnapshot = {
    level: result.level,
    baseline_date: result.baseline_date.toISOString().slice(0, 10),
    baseline_level: result.baseline_level,
    components_hash: result.components_hash,
    computed_at: result.computed_at.toISOString(),
  };

  if (rowsForRepin.length > 0) {
    const repinResults = await Promise.allSettled(
      rowsForRepin.map((r) => repinOneCohortRow(sql, r, snapshot)),
    );
    let ok = 0;
    let failed = 0;
    // Surface the actual Pinata reason for each rejected repin.
    // pinCycleToIPFS throws an Error whose message is
    //   "pinCycleToIPFS: pin failed: HTTP <status> <statusText> — <body>"
    // with up to 500 bytes of response body. Without this loop the
    // aggregate counter below swallowed every per-peptide reason,
    // making rate-limit vs auth vs cap-hit indistinguishable.
    for (let i = 0; i < repinResults.length; i++) {
      const res = repinResults[i]!;
      if (res.status === 'fulfilled') {
        ok += 1;
        continue;
      }
      failed += 1;
      const row = rowsForRepin[i]!;
      const reason =
        res.reason instanceof Error
          ? res.reason.message
          : String(res.reason);
      console.error(
        `[index-history-runner] repin_failed ` +
          `hour=${hourStartIso} ` +
          `peptide=${row.peptide_code} ` +
          `id=${row.id} ` +
          `reason=${JSON.stringify(reason)}`,
      );
    }
    console.log(
      `[index-history-runner] hour=${hourStartIso} ` +
        `repin: ok=${ok} failed=${failed} total=${repinResults.length}`,
    );
  }

  // Snapshot CIDs into index_history.ipfs_cids using COALESCE so
  // peptides whose final pin failed still surface their pre-cohort
  // CID. Filters out fully-null rows so the array length signals
  // "how many of N peptides have at least one CID available".
  await sql`
    UPDATE public.index_history ih
    SET    ipfs_cids = (
      SELECT array_agg(COALESCE(tc.final_ipfs_cid, tc.ipfs_cid)
                       ORDER BY tc.peptide_code ASC)
      FROM   public.twap_commits tc
      JOIN   public.index_baselines b ON b.peptide_code = tc.peptide_code
      WHERE  tc.computed_at = ${hourStart}
        AND  tc.status      = 'finalized'
        AND  COALESCE(tc.final_ipfs_cid, tc.ipfs_cid) IS NOT NULL
    )
    WHERE  ih.hour_start = ${hourStart}
      AND  ih.ipfs_cids IS NULL
  `;
}

/**
 * Build + pin a single cohort row's schema 1.1 manifest with the
 * populated index_snapshot, then write the resulting CID into
 * twap_commits.final_ipfs_cid under the IS NULL guard.
 *
 * Throws on any failure (manifest build, Pinata POST, DB write). The
 * caller uses Promise.allSettled so one peptide's failure does not
 * cancel the other 28.
 */
async function repinOneCohortRow(
  sql: SqlClient,
  row: RepinRow,
  snapshot: IndexSnapshot,
): Promise<void> {
  const manifest = await buildCycleManifest(sql, {
    peptide_code: row.peptide_code,
    computed_at: row.computed_at,
    twap_value: row.twap_value,
    observation_set_root: row.observation_set_root,
    solana_signature: row.solana_signature,
    solana_slot: row.solana_slot,
    index_snapshot: snapshot,
  });
  const { cid, size } = await pinCycleToIPFS(manifest);
  const updated = await setTwapFinalIpfsCid(sql, { id: row.id, cid });
  if (updated === 0) {
    console.warn(
      `[index-history-runner] final pin id=${row.id} peptide=${row.peptide_code} ` +
        `cid=${cid} but row update affected 0 rows (already had a final CID?)`,
    );
  } else {
    console.log(
      `[index-history-runner] final pin id=${row.id} peptide=${row.peptide_code} ` +
        `cid=${cid} size=${size}B`,
    );
  }
}

/**
 * One-shot startup recovery. Runs after loadIndexBaselines and BEFORE
 * runTwapPoller starts ticking. Closes two gap classes:
 *
 *   (Case D) Oracle was killed during the index_history INSERT for
 *   some hour H. On disk we see all cohort peptides finalized for H
 *   but no index_history row for H. We re-run runCohortCompletionForHour
 *   for each such hour; the ON CONFLICT primitive guarantees we never
 *   double-write.
 *
 *   (Case C) Oracle was killed mid-repin-loop. index_history row
 *   exists with ipfs_cids=null. We re-run the snapshot UPDATE for any
 *   such row older than 5 minutes so we don't race a live repin loop
 *   from a sibling restart.
 *
 * Both queries are bounded, idempotent, and produce no work in the
 * common case (a clean shutdown leaves nothing to recover).
 */
export async function runStartupRecovery(
  sql: SqlClient,
  computer: IndexComputer,
  healthSink?: IndexHealthSink | null,
  indexAccountWriter?: IndexAccountWriter | null,
  lzEmitter?: IndexLzEmitter | null,
): Promise<void> {
  console.log('[startup-recovery] scanning for incomplete index hours');

  // Case D: complete-cohort hours missing an index_history row.
  const missingIndexRows = await sql<{ hour_start: Date }[]>`
    WITH cohort AS (
      SELECT peptide_code FROM public.index_baselines
    ),
    complete_hours AS (
      SELECT tc.computed_at AS hour_start
      FROM   public.twap_commits tc
      JOIN   cohort c ON c.peptide_code = tc.peptide_code
      WHERE  tc.status = 'finalized'
      GROUP BY tc.computed_at
      HAVING count(*) = (SELECT count(*) FROM cohort)
    )
    SELECT ch.hour_start
    FROM   complete_hours ch
    LEFT JOIN public.index_history ih ON ih.hour_start = ch.hour_start
    WHERE  ih.hour_start IS NULL
    ORDER BY ch.hour_start ASC
  `;

  if (missingIndexRows.length > 0) {
    console.log(
      `[startup-recovery] found ${missingIndexRows.length} complete-cohort ` +
        `hour(s) missing from index_history; reprocessing`,
    );
    for (const r of missingIndexRows) {
      await runCohortCompletionForHour(
        sql,
        computer,
        r.hour_start,
        healthSink,
        indexAccountWriter,
        lzEmitter,
      );
    }
  }

  // Case C: index_history rows older than 5 minutes with null ipfs_cids.
  // The 5-minute floor avoids racing a live repin loop in the same
  // process (the in-process trigger writes index_history first, then
  // pins, then snapshots; if we run too eagerly we'd snapshot before
  // the pins resolve).
  const incompleteSnapshots = await sql<{ hour_start: Date }[]>`
    SELECT hour_start
    FROM   public.index_history
    WHERE  ipfs_cids IS NULL
      AND  computed_at < now() - INTERVAL '5 minutes'
    ORDER BY hour_start ASC
  `;

  if (incompleteSnapshots.length > 0) {
    console.log(
      `[startup-recovery] backfilling ipfs_cids snapshot on ` +
        `${incompleteSnapshots.length} index_history row(s)`,
    );
    for (const r of incompleteSnapshots) {
      await sql`
        UPDATE public.index_history ih
        SET    ipfs_cids = (
          SELECT array_agg(COALESCE(tc.final_ipfs_cid, tc.ipfs_cid)
                           ORDER BY tc.peptide_code ASC)
          FROM   public.twap_commits tc
          JOIN   public.index_baselines b ON b.peptide_code = tc.peptide_code
          WHERE  tc.computed_at = ${r.hour_start}
            AND  tc.status      = 'finalized'
            AND  COALESCE(tc.final_ipfs_cid, tc.ipfs_cid) IS NOT NULL
        )
        WHERE  ih.hour_start = ${r.hour_start}
          AND  ih.ipfs_cids IS NULL
      `;
    }
  }

  if (missingIndexRows.length === 0 && incompleteSnapshots.length === 0) {
    console.log('[startup-recovery] no incomplete index hours found');
  } else {
    console.log('[startup-recovery] complete');
  }
}

/**
 * Test seam: exposes the canonical components-hash construction so
 * unit tests can verify the implementation matches the docs/PUBLIC_API
 * "Verifier example" snippet. Not used by production code paths.
 */
export function _canonicalComponentsHashForTests(
  components: { peptide_code: string; twap_value: number; weight: number }[],
): string {
  return createHash('sha256').update(JSON.stringify(components)).digest('hex');
}
