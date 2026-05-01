import type { SqlClient } from "./client";
import {
  rowToObservation,
  type SupplierObservationRow,
} from "./observation-adapter";
import type { Observation } from "../canonical";

/**
 * Cycle detection + observation fetch for the cycle poller.
 *
 * Queries match §3.2.2 / §3.2.3 of the spec verbatim:
 *
 *   - findUnanchoredCycle: scraper_runs LEFT JOIN commit_cycles for
 *     cycles that completed successfully and aren't yet committed.
 *     Returns at most one row (the oldest); the caller processes
 *     cycles serially per §3.2.1.
 *
 *   - fetchCycleObservations: all in-leaf-eligible observations for a
 *     cycle. Ordered by id ASC (matches §02.4.5 Merkle leaf order so
 *     downstream code doesn't need to re-sort). Filters to
 *     scrape_success = true — failed-scrape rows are deliberately
 *     ineligible per §02.4.8 (they have no raw_html_hash, the
 *     canonical leaf would be undefined-valued).
 *
 *   - findInFlightCycles: status='pending' OR 'submitted' rows for the
 *     recovery poll (§3.2.3). Used by Phase C to reconcile rows whose
 *     submission state is ambiguous after a crash. Phase B's poller
 *     ignores them — they were ours but we can't progress them
 *     without the Solana submission code.
 */

export interface PendingCycle {
  cycle_id: number;
  started_at: Date;
  completed_at: Date;
}

/**
 * Find the next scrape cycle that's complete and successful but hasn't
 * been committed yet. LIMIT 1 — one cycle per poll, per spec §3.2.1.
 *
 * Returns null when there's no work.
 */
export async function findUnanchoredCycle(
  sql: SqlClient,
): Promise<PendingCycle | null> {
  const rows = await sql<
    {
      cycle_id: bigint | number;
      started_at: Date;
      completed_at: Date;
    }[]
  >`
    SELECT sr.id            AS cycle_id,
           sr.started_at,
           sr.finished_at    AS completed_at
    FROM   public.scraper_runs sr
    LEFT JOIN public.commit_cycles cc ON cc.cycle_id = sr.id
    WHERE  sr.finished_at IS NOT NULL
      AND  sr.status IN ('completed', 'partial')
      AND  cc.cycle_id IS NULL
      AND  EXISTS (
             SELECT 1 FROM public.supplier_observations o
             WHERE o.scraper_run_id = sr.id
               AND o.scrape_success = true
           )
    ORDER BY sr.id ASC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    cycle_id:
      typeof row.cycle_id === "bigint"
        ? Number(row.cycle_id)
        : row.cycle_id,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

/**
 * Fetch all in-leaf-eligible observations for a given cycle, in
 * canonical Observation form (ready to feed buildMerkleTree directly).
 *
 * Filters:
 *   scrape_success = true       — failed scrapes have no canonical leaf
 *   ordered by id ASC           — matches §02.4.5 leaf ordering
 *
 * The canonical-form transformation happens in the adapter
 * (rowToObservation) immediately on read, so the caller doesn't see
 * raw PG types.
 */
export async function fetchCycleObservations(
  sql: SqlClient,
  cycleId: number,
): Promise<Observation[]> {
  const rows = await sql<SupplierObservationRow[]>`
    SELECT id,
           supplier_id,
           peptide_id,
           supplier_product_id,
           scraper_run_id,
           observed_at,
           raw_price,
           raw_currency,
           fx_rate_to_usd,
           price_usd_per_mg,
           raw_availability,
           availability_tier,
           lead_time_days,
           scrape_success,
           scrape_error,
           http_status,
           raw_html_hash
    FROM   public.supplier_observations
    WHERE  scraper_run_id = ${cycleId}
      AND  scrape_success = true
    ORDER BY id ASC
  `;
  return rows.map(rowToObservation);
}

/**
 * Recovery poll for in-flight cycle commits (§3.2.3). Used by Phase C
 * to reconcile rows whose submission completed but DB write didn't, or
 * whose retry budget hasn't been exhausted yet. Phase B's cycle poller
 * doesn't act on these — it just notes them in the heartbeat.
 */
export async function findInFlightCycles(
  sql: SqlClient,
  limit = 5,
): Promise<
  {
    cycle_id: number;
    status: "pending" | "submitted";
    solana_signature: string | null;
    retry_count: number;
    last_error: string | null;
    created_at: Date;
  }[]
> {
  const rows = await sql<
    {
      cycle_id: bigint | number;
      status: "pending" | "submitted";
      solana_signature: string | null;
      retry_count: number;
      last_error: string | null;
      created_at: Date;
    }[]
  >`
    SELECT cycle_id,
           status,
           solana_signature,
           retry_count,
           last_error,
           created_at
    FROM   public.commit_cycles
    WHERE  status IN ('pending', 'submitted')
    ORDER BY created_at ASC
    LIMIT  ${limit}
  `;
  return rows.map((r) => ({
    cycle_id:
      typeof r.cycle_id === "bigint" ? Number(r.cycle_id) : r.cycle_id,
    status: r.status,
    solana_signature: r.solana_signature,
    retry_count: r.retry_count,
    last_error: r.last_error,
    created_at: r.created_at,
  }));
}
