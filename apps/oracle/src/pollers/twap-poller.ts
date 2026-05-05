import { sleepInterruptible } from "@peptide-oracle/shared";
import type { SqlClient } from "../db/client";
import {
  fetchTwapInputObservations,
  findEligibleTwapForCommit,
  listActivePeptides,
} from "../db/twap-detection";
import { registerTwapCommit } from "../db/twap-commit-writer";
import {
  findNextPendingTwap,
  findNextSubmittedTwap,
  markFailedTwap,
  markFinalizedTwap,
  markSubmittedTwap,
  resetToPendingTwap,
} from "../db/twap-state";
import type { OracleHealthState } from "../health";
import { isFinalized, type OracleSolanaClient } from "../solana/client";
import { classifyError, type ErrorClass } from "../solana/errors";
import {
  IN_FLIGHT_MAX_RETRIES,
  nextInFlightBackoff,
} from "../solana/retry-policy";
import type { Keypair } from "@solana/web3.js";
import { buildSignedMemoTx } from "../solana/memo-tx";
import { buildTwapCommit } from "../twap/memo";

/**
 * TWAP commit poller — Phase D scope (§3.3).
 *
 * The poller wakes at HH:00:30 UTC (top of hour + 30s skew per
 * §3.3.1) and commits one row per active peptide for the hour
 * that just ended. Between hour boundaries, the same loop drives
 * the lifecycle of any in-flight or pending row.
 *
 * Each tick walks three steps in priority order — same shape as
 * the cycle poller, just over twap_commits instead of commit_cycles:
 *
 *   1. RECONCILE in-flight ('submitted') rows against Solana.
 *   2. SUBMIT one 'pending' row.
 *   3. If we just crossed an HH:00:30 boundary, ENQUEUE new commits
 *      (one per active peptide).
 *
 * Why one combined loop instead of separate detection / submission
 * pollers: same advisory lock, same Solana client, same retry
 * policy as the cycle poller. Combining them keeps the
 * Solana-RPC concurrency bounded (one tx at a time across both
 * pollers, modulo per-tick interleaving) and simplifies shutdown.
 *
 * The cycle poller and TWAP poller run in parallel under
 * runCyclePoller() / runTwapPoller() respectively; both share the
 * same SqlClient and OracleSolanaClient. Solana RPC has no
 * single-flight concern (Helius handles concurrent calls fine),
 * and the §3.8.1 advisory lock keeps everything single-instance.
 */

export interface TwapPollerOptions {
  sql: SqlClient;
  /** Tick cadence (default 30s — matches cycle poller for symmetry). */
  tickIntervalMs: number;
  abortSignal: AbortSignal;
  health: OracleHealthState;
  solana: OracleSolanaClient;
  payer: Keypair;
  minBalanceLamports: number;
  confirmationTimeoutMs: number;
  /**
   * Minutes past the hour at which to enqueue. Default 0.5 (== 30s
   * skew per §3.3.1). Configurable for testing.
   */
  hourSkewMinutes?: number;
  /** Solana cluster stamped on every twap_commits row this poller writes. */
  cluster: "devnet" | "mainnet-beta" | "testnet";
}

export async function runTwapPoller(opts: TwapPollerOptions): Promise<void> {
  const skew = opts.hourSkewMinutes ?? 0.5;
  console.log(
    `[twap-poller] started (tick=${opts.tickIntervalMs}ms, ` +
      `enqueue at HH:${String(Math.floor(skew)).padStart(2, "0")}:` +
      `${String(Math.round((skew % 1) * 60)).padStart(2, "0")} UTC)`,
  );

  // The poller's primary job is the per-hour enqueue. Track the
  // most recent hour we've already enqueued so we don't re-enqueue
  // multiple times within the same hour. -1 = "never run yet".
  // On startup, this stays -1; the first tick whose wallclock is
  // past HH:00:30 will catch up the current hour.
  let lastEnqueuedHourBoundaryMs = -1;

  while (!opts.abortSignal.aborted) {
    try {
      await tick(opts, {
        skewMinutes: skew,
        lastEnqueuedHourBoundaryMs,
        setLastEnqueued: (ms) => {
          lastEnqueuedHourBoundaryMs = ms;
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[twap-poller] tick failed: ${msg}`);
    }
    if (opts.abortSignal.aborted) break;
    await sleepInterruptible(opts.tickIntervalMs, opts.abortSignal);
  }
  console.log("[twap-poller] shutdown");
}

interface TickState {
  skewMinutes: number;
  lastEnqueuedHourBoundaryMs: number;
  setLastEnqueued: (ms: number) => void;
}

async function tick(
  opts: TwapPollerOptions,
  state: TickState,
): Promise<void> {
  // 1. Reconcile in-flight TWAP commits.
  await reconcileInFlight(opts);
  if (opts.abortSignal.aborted) return;

  // 2. Submit one pending row.
  await submitOnePending(opts);
  if (opts.abortSignal.aborted) return;

  // 3. Hour-boundary enqueue. Walks all active peptides, inserting
  // a 'pending' twap_commits row for any whose latest peptide_twaps
  // row hasn't been committed yet.
  const now = new Date();
  const hourBoundary = mostRecentEnqueueDeadline(now, state.skewMinutes);
  if (
    hourBoundary &&
    hourBoundary.getTime() > state.lastEnqueuedHourBoundaryMs
  ) {
    await enqueueHourly(opts, hourBoundary);
    state.setLastEnqueued(hourBoundary.getTime());
  }
}

/**
 * Returns the hour boundary that we should already have processed by
 * the current wall-clock time, or null if we haven't crossed the
 * hourSkewMinutes mark of any hour yet.
 *
 * Example with skew=0.5 (HH:00:30):
 *   now=12:00:00 → returns null (haven't crossed 12:00:30 yet;
 *                  the 11:00 hour boundary was processed earlier)
 *   now=12:00:31 → returns 12:00:00 (process the 11:00→12:00 hour)
 *   now=12:30:00 → returns 12:00:00 (still in the same window)
 *   now=13:00:31 → returns 13:00:00 (process the 12:00→13:00 hour)
 */
export function mostRecentEnqueueDeadline(
  now: Date,
  skewMinutes: number,
): Date | null {
  const skewMs = skewMinutes * 60_000;
  // Round down to the start of the current UTC hour.
  const hourStart = new Date(now);
  hourStart.setUTCMinutes(0, 0, 0);
  // Have we crossed HH:skew of this hour?
  if (now.getTime() >= hourStart.getTime() + skewMs) {
    return hourStart; // process the just-ended hour [HH-1:00, HH:00)
  }
  return null; // not yet past HH:skew
}

// ─── Step 1: Reconcile a 'submitted' TWAP row ──────────────────────────

async function reconcileInFlight(opts: TwapPollerOptions): Promise<void> {
  const inFlight = await findNextSubmittedTwap(opts.sql);
  if (!inFlight) return;

  const { id, peptide_code, solana_signature, submitted_at, retry_count } =
    inFlight;
  let status;
  try {
    status = await opts.solana.getSignatureStatus(solana_signature);
  } catch (err) {
    const cls = classifyError(err);
    console.warn(
      `[twap-poller] reconcile peptide=${peptide_code} sig=${solana_signature} ` +
        `getSignatureStatus failed (${cls.class}): ${cls.message}`,
    );
    return;
  }

  if (isFinalized(status)) {
    const slot = status?.slot ?? 0;
    await markFinalizedTwap(opts.sql, {
      id,
      solana_slot: slot,
      finalized_at: new Date(),
    });
    opts.health.twap.last_commit_at = new Date().toISOString();
    opts.health.twap.in_flight_count = Math.max(
      0,
      opts.health.twap.in_flight_count - 1,
    );
    console.log(
      `[twap-poller] peptide=${peptide_code} FINALIZED slot=${slot} ` +
        `sig=${solana_signature}`,
    );
    return;
  }

  if (status?.err !== null && status?.err !== undefined) {
    const errMsg = JSON.stringify(status.err);
    console.warn(
      `[twap-poller] peptide=${peptide_code} tx error: ${errMsg}`,
    );
    await handlePostSubmitFailure(opts, {
      id,
      peptide_code,
      retry_count,
      lastErrorClass: "INVALID_TRANSACTION",
      lastErrorMessage: `tx_error: ${errMsg}`,
      orphanedSignature: solana_signature,
    });
    return;
  }

  const ageMs = Date.now() - new Date(submitted_at).getTime();
  if (ageMs < opts.confirmationTimeoutMs) return;

  let recheck;
  try {
    recheck = await opts.solana.getSignatureStatus(solana_signature);
  } catch {
    recheck = null;
  }
  if (isFinalized(recheck)) {
    const slot = recheck?.slot ?? 0;
    await markFinalizedTwap(opts.sql, {
      id,
      solana_slot: slot,
      finalized_at: new Date(),
    });
    opts.health.twap.last_commit_at = new Date().toISOString();
    opts.health.twap.in_flight_count = Math.max(
      0,
      opts.health.twap.in_flight_count - 1,
    );
    console.log(
      `[twap-poller] peptide=${peptide_code} FINALIZED (late) slot=${slot}`,
    );
    return;
  }

  console.warn(
    `[twap-poller] peptide=${peptide_code} sig=${solana_signature} dropped ` +
      `(>${opts.confirmationTimeoutMs}ms past submit, status not finalized)`,
  );
  await handlePostSubmitFailure(opts, {
    id,
    peptide_code,
    retry_count,
    lastErrorClass: "CONFIRMATION_TIMEOUT",
    lastErrorMessage: `dropped (orphan sig=${solana_signature})`,
    orphanedSignature: solana_signature,
  });
}

// ─── Step 2: Submit a 'pending' TWAP row ───────────────────────────────

async function submitOnePending(opts: TwapPollerOptions): Promise<void> {
  const pending = await findNextPendingTwap(opts.sql);
  if (!pending) return;

  if (pending.retry_count >= IN_FLIGHT_MAX_RETRIES) {
    console.warn(
      `[twap-poller] id=${pending.id} (peptide=${pending.peptide_code}) ` +
        `retry budget exhausted (${pending.retry_count}/${IN_FLIGHT_MAX_RETRIES}); ` +
        `marking failed`,
    );
    await markFailedTwap(opts.sql, {
      id: pending.id,
      last_error: pending.last_error ?? "in-flight retry budget exhausted",
      incrementRetry: false,
    });
    return;
  }

  // §3.5.2 / §3.7.3 balance gate.
  let balanceLamports: number;
  try {
    balanceLamports = await opts.solana.getBalanceLamports(
      opts.payer.publicKey.toBase58(),
    );
  } catch (err) {
    const cls = classifyError(err);
    console.warn(
      `[twap-poller] balance check failed (${cls.class}): ${cls.message}; ` +
        `skipping submit this tick`,
    );
    return;
  }
  if (balanceLamports < opts.minBalanceLamports) {
    const sol = balanceLamports / 1e9;
    console.error(
      `[twap-poller] id=${pending.id} INSUFFICIENT_SOL: ` +
        `balance=${sol} SOL < min=${opts.minBalanceLamports / 1e9} SOL; ` +
        `marking failed (§3.7.3)`,
    );
    await markFailedTwap(opts.sql, {
      id: pending.id,
      last_error: `INSUFFICIENT_SOL: balance=${sol} SOL`,
      incrementRetry: true,
    });
    return;
  }
  opts.health.wallet.balance_sol = (balanceLamports / 1e9).toFixed(6);

  let blockhash;
  try {
    blockhash = await opts.solana.getLatestBlockhash();
  } catch (err) {
    const cls = classifyError(err);
    console.warn(
      `[twap-poller] getLatestBlockhash failed (${cls.class}): ${cls.message}`,
    );
    return;
  }

  let priorityFee: number;
  try {
    const draft = buildSignedMemoTx({
      memo: pending.memo_payload,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      payer: opts.payer,
      priorityFeeMicroLamports: 1000,
      cuLimit: 150_000,
    });
    priorityFee = await opts.solana.getPriorityFeeEstimateMicroLamports(
      Buffer.from(draft.serialized).toString("base64"),
      "High",
    );
  } catch (err) {
    console.warn(
      `[twap-poller] priority fee estimate failed (${(err as Error).message}); ` +
        `using 1000 µlamports/CU fallback`,
    );
    priorityFee = 1000;
  }
  priorityFee = Math.min(priorityFee, 50_000);

  let signed;
  try {
    signed = buildSignedMemoTx({
      memo: pending.memo_payload,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      payer: opts.payer,
      priorityFeeMicroLamports: priorityFee,
      cuLimit: 150_000,
    });
  } catch (err) {
    const cls = classifyError(err);
    console.error(
      `[twap-poller] id=${pending.id} build/sign failed ` +
        `(${cls.class}): ${cls.message}`,
    );
    await markFailedTwap(opts.sql, {
      id: pending.id,
      last_error: `build_failure: ${cls.message}`,
      incrementRetry: true,
    });
    return;
  }

  // §3.7.5 race-safe ordering: write signature + status='submitted' BEFORE send.
  const submittedAt = new Date();
  const updated = await markSubmittedTwap(opts.sql, {
    id: pending.id,
    signature: signed.signature,
    submitted_at: submittedAt,
  });
  if (updated !== 1) {
    console.warn(
      `[twap-poller] id=${pending.id} markSubmittedTwap affected ${updated} ` +
        `rows (expected 1); skipping send`,
    );
    return;
  }

  try {
    await opts.solana.sendRawTransaction(signed.serialized);
    console.log(
      `[twap-poller] id=${pending.id} peptide=${pending.peptide_code} ` +
        `SUBMITTED sig=${signed.signature} priorityFee=${priorityFee}µlamports/CU`,
    );
    opts.health.twap.in_flight_count += 1;
    return;
  } catch (err) {
    const cls = classifyError(err);
    console.warn(
      `[twap-poller] id=${pending.id} sendTransaction failed ` +
        `(${cls.class}): ${cls.message}`,
    );

    if (cls.class === "BLOCKHASH_EXPIRED") {
      opts.solana.invalidateBlockhash();
      await resetToPendingTwap(opts.sql, {
        id: pending.id,
        last_error: `BLOCKHASH_EXPIRED at submit: ${cls.message}`,
        incrementRetry: false,
      });
      return;
    }
    if (cls.class === "INSUFFICIENT_SOL") {
      await markFailedTwap(opts.sql, {
        id: pending.id,
        last_error: `INSUFFICIENT_SOL at submit: ${cls.message}`,
        incrementRetry: true,
      });
      return;
    }
    if (cls.class === "INVALID_TRANSACTION") {
      await markFailedTwap(opts.sql, {
        id: pending.id,
        last_error: `INVALID_TRANSACTION at submit: ${cls.message}`,
        incrementRetry: true,
      });
      return;
    }
    // RPC_TRANSIENT, RPC_RATE_LIMITED, SIGNATURE_ALREADY_EXISTS,
    // UNKNOWN: leave the row at 'submitted' for next-tick reconciliation.
  }
}

// ─── Step 3: Hourly enqueue ────────────────────────────────────────────

async function enqueueHourly(
  opts: TwapPollerOptions,
  hourBoundary: Date,
): Promise<void> {
  const peptides = await listActivePeptides(opts.sql);
  if (peptides.length === 0) {
    console.log(
      `[twap-poller] hourBoundary=${hourBoundary.toISOString()} ` +
        `no active peptides; nothing to enqueue`,
    );
    return;
  }

  let inserted = 0;
  let skippedNoTwap = 0;
  let skippedAlreadyCommitted = 0;
  let errored = 0;

  for (const peptide of peptides) {
    if (opts.abortSignal.aborted) break;
    try {
      const eligible = await findEligibleTwapForCommit(opts.sql, {
        peptide,
        hourBoundary,
      });
      if (!eligible) {
        // Either no peptide_twaps row for this hour, or already
        // committed. Distinguishing the two would need a second
        // query; for v1 the log message is intentionally vague.
        skippedNoTwap += 1;
        continue;
      }

      const observations = await fetchTwapInputObservations(
        opts.sql,
        eligible.input_observation_ids,
      );
      const { memo, observationSetRootHex } = buildTwapCommit({
        peptide_code: eligible.peptide_code,
        twap_value: eligible.twap_value,
        computed_at: eligible.computed_at.toISOString(),
        window_start: eligible.window_start.toISOString(),
        window_end: eligible.window_end.toISOString(),
        observations,
      });

      const result = await registerTwapCommit(opts.sql, {
        peptide_code: eligible.peptide_code,
        twap_value: eligible.twap_value,
        computed_at: eligible.computed_at,
        window_start: eligible.window_start,
        window_end: eligible.window_end,
        observation_set_root: observationSetRootHex,
        memo_payload: memo,
        cluster: opts.cluster,
      });
      if (result.inserted) {
        inserted += 1;
        console.log(
          `[twap-poller] enqueued peptide=${eligible.peptide_code} ` +
            `computed_at=${eligible.computed_at.toISOString()} ` +
            `root=${observationSetRootHex} memo_bytes=${Buffer.byteLength(memo, "utf-8")}`,
        );
      } else {
        skippedAlreadyCommitted += 1;
      }
    } catch (err) {
      errored += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[twap-poller] enqueue peptide=${peptide.peptide_code} failed: ${msg}`,
      );
    }
  }

  console.log(
    `[twap-poller] hourBoundary=${hourBoundary.toISOString()} ` +
      `enqueue: inserted=${inserted} skipped_no_twap=${skippedNoTwap} ` +
      `skipped_already_committed=${skippedAlreadyCommitted} errored=${errored}`,
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface PostSubmitFailureArgs {
  id: string;
  peptide_code: string;
  retry_count: number;
  lastErrorClass: ErrorClass;
  lastErrorMessage: string;
  orphanedSignature: string;
}

async function handlePostSubmitFailure(
  opts: TwapPollerOptions,
  args: PostSubmitFailureArgs,
): Promise<void> {
  const decision = nextInFlightBackoff(args.retry_count, args.lastErrorClass);
  const auditMsg =
    `${args.lastErrorClass}: ${args.lastErrorMessage} ` +
    `(orphan_sig=${args.orphanedSignature})`;

  if (
    args.lastErrorClass === "INSUFFICIENT_SOL" ||
    args.lastErrorClass === "INVALID_TRANSACTION"
  ) {
    await markFailedTwap(opts.sql, {
      id: args.id,
      last_error: auditMsg,
      incrementRetry: true,
    });
    opts.health.twap.in_flight_count = Math.max(
      0,
      opts.health.twap.in_flight_count - 1,
    );
    return;
  }

  if (decision.isLastAttempt && args.retry_count + 1 >= IN_FLIGHT_MAX_RETRIES) {
    await markFailedTwap(opts.sql, {
      id: args.id,
      last_error: auditMsg,
      incrementRetry: true,
    });
    opts.health.twap.in_flight_count = Math.max(
      0,
      opts.health.twap.in_flight_count - 1,
    );
    console.warn(
      `[twap-poller] id=${args.id} (peptide=${args.peptide_code}) retry ` +
        `budget exhausted; failed`,
    );
    return;
  }

  await resetToPendingTwap(opts.sql, {
    id: args.id,
    last_error: auditMsg,
    incrementRetry: decision.countAgainstBudget,
  });
  opts.health.twap.in_flight_count = Math.max(
    0,
    opts.health.twap.in_flight_count - 1,
  );
}
