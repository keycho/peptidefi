import type { SqlClient } from "./client";

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
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.twap_commits
      SET    status       = 'finalized',
             solana_slot  = ${args.solana_slot},
             finalized_at = ${args.finalized_at}
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
} | null> {
  const rows = await sql<
    {
      id: string;
      peptide_code: string;
      solana_signature: string;
      submitted_at: Date;
      retry_count: number;
    }[]
  >`
    SELECT id, peptide_code, solana_signature, submitted_at, retry_count
    FROM   public.twap_commits
    WHERE  status = 'submitted'
      AND  solana_signature IS NOT NULL
    ORDER BY submitted_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
