import type { SqlClient } from "./client";

/**
 * State-transition writes for commit_cycles, per the §3.7.5 race-
 * safe ordering:
 *
 *   pending  →  submitted   (markSubmitted; signature already known)
 *   submitted →  finalized   (markFinalized; slot known)
 *   submitted →  pending     (resetToPending; §3.7.4 dropped tx)
 *   {pending,submitted} → failed (markFailed; budget exhausted or terminal class)
 *
 * Each helper UPDATEs with a `WHERE status = <expected>` guard so
 * concurrent processes (or a duplicate poll) can't double-transition
 * a row. Returns rowCount; callers are expected to assert it's 1.
 *
 * The single-instance advisory lock (§3.8.1) makes concurrent
 * transitions impossible in practice for a correctly-deployed
 * service. The WHERE-status guards are belt-and-suspenders against
 * a missed-lock or operator-error scenario.
 *
 * SECURITY-RELEVANT: NEVER overwrite solana_signature blindly.
 * resetToPending CLEARS the signature (the dropped tx's sig becomes
 * orphaned audit trail in last_error). markSubmitted only sets a
 * signature on a previously-NULL row (the WHERE status='pending'
 * guard implies signature IS NULL since pending rows haven't been
 * signed yet).
 */

export async function markSubmitted(
  sql: SqlClient,
  args: {
    cycle_id: number;
    signature: string;
    submitted_at: Date;
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.commit_cycles
      SET    solana_signature = ${args.signature},
             status           = 'submitted',
             submitted_at     = ${args.submitted_at}
      WHERE  cycle_id = ${args.cycle_id}
        AND  status   = 'pending'
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

export async function markFinalized(
  sql: SqlClient,
  args: {
    cycle_id: number;
    solana_slot: number;
    finalized_at: Date;
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.commit_cycles
      SET    status       = 'finalized',
             solana_slot  = ${args.solana_slot},
             finalized_at = ${args.finalized_at}
      WHERE  cycle_id = ${args.cycle_id}
        AND  status   = 'submitted'
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

export async function markFailed(
  sql: SqlClient,
  args: {
    cycle_id: number;
    last_error: string;
    /** True if we should also bump retry_count (e.g., on budget exhaustion). */
    incrementRetry?: boolean;
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.commit_cycles
      SET    status      = 'failed',
             last_error  = ${args.last_error},
             retry_count = retry_count + ${args.incrementRetry ? 1 : 0}
      WHERE  cycle_id = ${args.cycle_id}
        AND  status IN ('pending', 'submitted', 'failed')
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

/**
 * Reset a 'submitted' row back to 'pending' for re-submission per
 * §3.7.4 (the prior tx was dropped — blockhash expired without
 * confirmation). Records the orphaned signature in `last_error` for
 * audit, then clears it.
 *
 * Note: submitted_at is left POPULATED (= "the time of the last
 * attempt") so the §3.7.1 backoff schedule can compute "wait
 * X seconds since last failure" against it on the next poll. The
 * markSubmitted() call on the next attempt will overwrite it with
 * the fresh submission time.
 */
export async function resetToPending(
  sql: SqlClient,
  args: {
    cycle_id: number;
    last_error: string;
    incrementRetry?: boolean;
  },
): Promise<number> {
  const rows = await sql<{ updated: number }[]>`
    WITH updated AS (
      UPDATE public.commit_cycles
      SET    status            = 'pending',
             solana_signature  = NULL,
             last_error        = ${args.last_error},
             retry_count       = retry_count + ${args.incrementRetry ? 1 : 0}
      WHERE  cycle_id = ${args.cycle_id}
        AND  status   IN ('submitted', 'failed')
      RETURNING 1 AS updated
    )
    SELECT count(*)::int AS updated FROM updated
  `;
  return rows[0]?.updated ?? 0;
}

/**
 * Find the next 'pending' row to submit. Returns null if none.
 * Includes retry_count + last_error so the caller can apply
 * §3.7.1 backoff before the actual submit.
 */
export async function findNextPending(sql: SqlClient): Promise<{
  cycle_id: number;
  memo_payload: string;
  retry_count: number;
  last_error: string | null;
  created_at: Date;
} | null> {
  const rows = await sql<
    {
      cycle_id: bigint | number;
      memo_payload: string;
      retry_count: number;
      last_error: string | null;
      created_at: Date;
    }[]
  >`
    SELECT cycle_id, memo_payload, retry_count, last_error, created_at
    FROM   public.commit_cycles
    WHERE  status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    cycle_id:
      typeof row.cycle_id === "bigint" ? Number(row.cycle_id) : row.cycle_id,
    memo_payload: row.memo_payload,
    retry_count: row.retry_count,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

/**
 * Find the next 'submitted' row that needs reconciliation. Returns
 * null if none.
 */
export async function findNextSubmitted(sql: SqlClient): Promise<{
  cycle_id: number;
  solana_signature: string;
  submitted_at: Date;
  retry_count: number;
} | null> {
  const rows = await sql<
    {
      cycle_id: bigint | number;
      solana_signature: string;
      submitted_at: Date;
      retry_count: number;
    }[]
  >`
    SELECT cycle_id, solana_signature, submitted_at, retry_count
    FROM   public.commit_cycles
    WHERE  status = 'submitted'
      AND  solana_signature IS NOT NULL
    ORDER BY submitted_at ASC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    cycle_id:
      typeof row.cycle_id === "bigint" ? Number(row.cycle_id) : row.cycle_id,
    solana_signature: row.solana_signature,
    submitted_at: row.submitted_at,
    retry_count: row.retry_count,
  };
}

/**
 * Long-tail retry candidates: status='failed' rows whose retry_count
 * is below ORACLE_MAX_TOTAL_RETRIES and whose last failure is old
 * enough per §3.7.7 backoff.
 */
export async function findFailedReadyForLongTail(
  sql: SqlClient,
  args: {
    maxTotalRetries: number;
    /** Wall-clock cutoff: only rows whose last failure is older than this. */
    minLastFailureBefore: Date;
    limit?: number;
  },
): Promise<
  {
    cycle_id: number;
    retry_count: number;
    last_error: string | null;
  }[]
> {
  const rows = await sql<
    {
      cycle_id: bigint | number;
      retry_count: number;
      last_error: string | null;
    }[]
  >`
    SELECT cycle_id, retry_count, last_error
    FROM   public.commit_cycles
    WHERE  status      = 'failed'
      AND  retry_count < ${args.maxTotalRetries}
      AND  COALESCE(submitted_at, created_at) < ${args.minLastFailureBefore}
    ORDER BY created_at ASC
    LIMIT  ${args.limit ?? 5}
  `;
  return rows.map((r) => ({
    cycle_id:
      typeof r.cycle_id === "bigint" ? Number(r.cycle_id) : r.cycle_id,
    retry_count: r.retry_count,
    last_error: r.last_error,
  }));
}
