import type { SqlClient } from './client';

/**
 * State-transition writes for twap_commits — the UUID-keyed analog
 * of cycle-state.ts. Same race-safe ordering per §3.7.5:
 *
 *   pending  →  submitted   (markSubmittedTwap; signature already known)
 *   submitted →  finalized   (markFinalizedTwap; slot known)
 *   submitted →  pending     (resetToPendingTwap; §3.7.4 dropped tx)
 *   {pending,submitted} → failed (markFailedTwap; budget exhausted or terminal class)
 *
 * Each helper UPDATEs with a `WHERE status = <expected>` guard so
 * concurrent processes (or a duplicate poll) can't double-transition
 * a row. Returns rowCount; callers are expected to assert it's 1.
 *
 * SECURITY-RELEVANT: NEVER overwrite solana_signature blindly.
 * resetToPendingTwap CLEARS the signature (the dropped tx's sig
 * becomes orphaned audit trail in last_error).
 */

export async function markSubmittedTwap(
  sql: SqlClient,
  args: {
    id: string;
    signature: string;
    submitted_at: Date;
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.twap_commits
      SET    solana_signature = ${args.signature},
             status           = 'submitted',
             submitted_at     = ${args.submitted_at}
      WHERE  id = ${args.id}
        AND  status = 'pending'
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

export async function markFinalizedTwap(
  sql: SqlClient,
  args: {
    id: string;
    solana_slot: number;
    finalized_at: Date;
    /** Verification attestation captured from getTransaction. See
     *  cycle-state.markFinalized for the full rationale. Nullable
     *  on the write path so a transient RPC failure doesn't block
     *  finalization; backfill picks up the gap. */
    onchain_memo_bytes: string | null;
    authority_pubkey: string | null;
    confirmed_slot: number | null;
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.twap_commits
      SET    status              = 'finalized',
             solana_slot         = ${args.solana_slot},
             finalized_at        = ${args.finalized_at},
             onchain_memo_bytes  = ${args.onchain_memo_bytes},
             authority_pubkey    = ${args.authority_pubkey},
             confirmed_slot      = ${args.confirmed_slot}
      WHERE  id = ${args.id}
        AND  status = 'submitted'
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

export async function markFailedTwap(
  sql: SqlClient,
  args: {
    id: string;
    last_error: string;
    incrementRetry?: boolean;
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.twap_commits
      SET    status      = 'failed',
             last_error  = ${args.last_error},
             retry_count = retry_count + ${args.incrementRetry ? 1 : 0}
      WHERE  id = ${args.id}
        AND  status IN ('pending', 'submitted', 'failed')
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

/**
 * §3.7.4 dropped-tx reset. Like cycle-state.ts: leaves submitted_at
 * populated so backoff math has a "last attempt time" to compute
 * against; the next markSubmittedTwap call overwrites it.
 */
export async function resetToPendingTwap(
  sql: SqlClient,
  args: {
    id: string;
    last_error: string;
    incrementRetry?: boolean;
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.twap_commits
      SET    status            = 'pending',
             solana_signature  = NULL,
             last_error        = ${args.last_error},
             retry_count       = retry_count + ${args.incrementRetry ? 1 : 0}
      WHERE  id = ${args.id}
        AND  status IN ('submitted', 'failed')
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

export async function findNextPendingTwap(sql: SqlClient): Promise<{
  id: string;
  peptide_code: string;
  memo_payload: string;
  computed_at: Date;
  retry_count: number;
  last_error: string | null;
} | null> {
  const rows = await sql<
    {
      id: string;
      peptide_code: string;
      memo_payload: string;
      computed_at: Date;
      retry_count: number;
      last_error: string | null;
    }[]
  >`
    SELECT id, peptide_code, memo_payload, computed_at, retry_count, last_error
    FROM   public.twap_commits
    WHERE  status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findNextSubmittedTwap(sql: SqlClient): Promise<{
  id: string;
  peptide_code: string;
  solana_signature: string;
  submitted_at: Date;
  retry_count: number;
  /** numeric(20,6); arrives as a string from postgres.js. e.g. "5.998000". */
  twap_value: string;
  /** "0x" + 64 hex. Same value embedded in the TWAP commit memo + needed by peg-pusher. */
  observation_set_root: string;
  /** Used by the IPFS manifest builder to join back to peptide_twaps. */
  computed_at: Date;
} | null> {
  const rows = await sql<
    {
      id: string;
      peptide_code: string;
      solana_signature: string;
      submitted_at: Date;
      retry_count: number;
      twap_value: string;
      observation_set_root: string;
      computed_at: Date;
    }[]
  >`
    SELECT id, peptide_code, solana_signature, submitted_at, retry_count,
           twap_value::text AS twap_value,
           observation_set_root,
           computed_at
    FROM   public.twap_commits
    WHERE  status = 'submitted'
      AND  solana_signature IS NOT NULL
    ORDER BY submitted_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Persist the IPFS CID of a finalized TWAP commit's pinned manifest.
 *
 * No state-machine transition — `ipfs_cid` is an additive audit-trail
 * column added in migration 0042. Writes are idempotent at the row
 * level: a successful pin writes once, and the fire-and-forget call
 * site (twap-poller.ts) never retries against an already-pinned row
 * because the row only flows through reconcileInFlight on the
 * submitted → finalized transition. The `id` guard makes a double-write
 * a no-op rather than a corruption.
 *
 * Returns rowCount; callers may assert it's 1 in development.
 */
export async function setTwapIpfsCid(
  sql: SqlClient,
  args: { id: string; cid: string },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.twap_commits
      SET    ipfs_cid = ${args.cid}
      WHERE  id        = ${args.id}
        AND  ipfs_cid IS NULL
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

/**
 * Persist the IPFS CID of the SCHEMA 1.1 final pin -- the manifest
 * pinned after the cohort completes for the hour and the index_snapshot
 * gets populated. Sibling of setTwapIpfsCid above. Same idempotency
 * pattern: the WHERE guard on `final_ipfs_cid IS NULL` makes a
 * double-write a no-op rather than a corruption, which matters because
 * the cohort-completion path may fire from two sources (the in-process
 * trigger after the cohort-completing markFinalizedTwap, and the
 * startup recovery path on oracle restart).
 *
 * See migration 0044 for the column rationale and the pin-twice design.
 */
export async function setTwapFinalIpfsCid(
  sql: SqlClient,
  args: { id: string; cid: string },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.twap_commits
      SET    final_ipfs_cid = ${args.cid}
      WHERE  id              = ${args.id}
        AND  final_ipfs_cid IS NULL
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}
