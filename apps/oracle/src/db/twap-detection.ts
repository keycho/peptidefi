import type { SqlClient } from "./client";
import {
  rowToObservation,
  type SupplierObservationRow,
} from "./observation-adapter";
import type { Observation } from "@peptide-oracle/shared";

/**
 * Detection + row-fetch queries for the TWAP poller (§3.3).
 *
 * Three queries:
 *
 *   - listActivePeptides: the §3.3.4 active-set per the v1 decision
 *     (all peptides.is_active = true). One row per peptide; the
 *     poller iterates through these at the hour boundary.
 *
 *   - findEligibleTwapForCommit: per peptide, the latest peptide_twaps
 *     row at-or-before a given hour boundary that still has a
 *     non-null TWAP value AND hasn't already been committed (no
 *     existing twap_commits row for that (peptide_code, computed_at)).
 *     Returns null if there's nothing to commit (thin-data hour, or
 *     already committed). Per §3.3.2.
 *
 *   - fetchTwapInputObservations: hydrate the input_observation_ids
 *     array on a peptide_twaps row into full canonical Observation
 *     objects. Used to compute the observation_set_root via the
 *     existing buildMerkleTree primitive (§02.4).
 */

export interface ActivePeptide {
  peptide_id: number;
  peptide_code: string;
}

export async function listActivePeptides(
  sql: SqlClient,
): Promise<ActivePeptide[]> {
  const rows = await sql<
    {
      peptide_id: bigint | number;
      peptide_code: string;
    }[]
  >`
    SELECT id   AS peptide_id,
           code AS peptide_code
    FROM   public.peptides
    WHERE  is_active = true
    ORDER BY id ASC
  `;
  return rows.map((r) => ({
    peptide_id:
      typeof r.peptide_id === "bigint"
        ? Number(r.peptide_id)
        : r.peptide_id,
    peptide_code: r.peptide_code,
  }));
}

export interface EligibleTwap {
  /** peptide_twaps.id */
  twap_id: number;
  peptide_id: number;
  peptide_code: string;
  /** ISO 8601 string at canonical ms-precision. */
  computed_at: Date;
  window_start: Date;
  window_end: Date;
  /** Decimal string per §02.5 (PG numeric serialized as text). */
  twap_value: string;
  input_observation_ids: number[];
}

/**
 * Find the latest peptide_twaps row for a peptide that:
 *   - has computed_at <= hourBoundary (§3.3.2)
 *   - has a non-null twap_usd_per_mg (skip thin-data rows)
 *   - has at least one entry in input_observation_ids (defensive —
 *     a row with no inputs would build an empty Merkle tree, which
 *     §3.3.3 step 3 implicitly forbids by referencing the input set)
 *   - does NOT already have a finalized twap_commits row at the
 *     same (peptide_code, computed_at). The unique constraint on
 *     twap_commits.(peptide_code, computed_at) makes this query a
 *     defensive pre-check; the real idempotency guard is the unique
 *     constraint at insert time.
 *
 * Returns null when none of the above is true (skip this peptide
 * for this hour).
 */
export async function findEligibleTwapForCommit(
  sql: SqlClient,
  args: { peptide: ActivePeptide; hourBoundary: Date },
): Promise<EligibleTwap | null> {
  const rows = await sql<
    {
      twap_id: bigint | number;
      peptide_id: bigint | number;
      computed_at: Date;
      window_start: Date;
      window_end: Date;
      twap_value: string;
      input_observation_ids: (bigint | number)[] | string;
    }[]
  >`
    SELECT pt.id              AS twap_id,
           pt.peptide_id,
           pt.computed_at,
           pt.window_start,
           pt.window_end,
           pt.twap_usd_per_mg::text AS twap_value,
           pt.input_observation_ids
    FROM   public.peptide_twaps pt
    WHERE  pt.peptide_id = ${args.peptide.peptide_id}
      AND  pt.computed_at <= ${args.hourBoundary}
      AND  pt.twap_usd_per_mg IS NOT NULL
      AND  array_length(pt.input_observation_ids, 1) >= 1
      AND  NOT EXISTS (
             SELECT 1 FROM public.twap_commits tc
             WHERE  tc.peptide_code = ${args.peptide.peptide_code}
               AND  tc.computed_at  = pt.computed_at
           )
    ORDER BY pt.computed_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  // input_observation_ids may come back as a JS array of bigints/numbers
  // or as a postgres-formatted text array string ("{1001,1002,1003}")
  // depending on the driver path. Normalize both.
  const ids = normalizeBigintArray(row.input_observation_ids);
  return {
    twap_id:
      typeof row.twap_id === "bigint" ? Number(row.twap_id) : row.twap_id,
    peptide_id: args.peptide.peptide_id,
    peptide_code: args.peptide.peptide_code,
    computed_at: row.computed_at,
    window_start: row.window_start,
    window_end: row.window_end,
    twap_value: row.twap_value,
    input_observation_ids: ids,
  };
}

/**
 * Fetch the canonical Observation objects for a list of
 * supplier_observations.id values. Used to compute the
 * observation_set_root for a TWAP commit memo.
 *
 * No filter on scrape_success — the worker's input_observation_ids
 * already represents the filtered set it actually used (per
 * `apps/worker/src/twap.ts`: latest-per-supplier within freshness,
 * scrape_success=true, in_stock). We trust the worker's filter
 * decision here so the on-chain root matches the off-chain TWAP
 * computation.
 *
 * Order in the returned array is whatever PG returns; buildMerkleTree
 * sorts by id ASC internally, so the caller doesn't have to.
 */
export async function fetchTwapInputObservations(
  sql: SqlClient,
  ids: number[],
): Promise<Observation[]> {
  if (ids.length === 0) return [];
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
    WHERE  id = ANY(${ids})
  `;
  if (rows.length !== ids.length) {
    throw new Error(
      `twap-detection: expected ${ids.length} observation rows for the ` +
        `TWAP input set, got ${rows.length}. Some input_observation_ids ` +
        `must have been deleted — refusing to commit a TWAP whose root ` +
        `would not reproduce.`,
    );
  }
  return rows.map(rowToObservation);
}

// ─── Helpers ───────────────────────────────────────────────────────────

function normalizeBigintArray(
  value: (bigint | number)[] | string,
): number[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "bigint" ? Number(v) : v));
  }
  // Postgres array text shape: "{1001,1002,1003}".
  if (typeof value === "string") {
    const trimmed = value.replace(/^\{|\}$/g, "");
    if (trimmed === "") return [];
    return trimmed.split(",").map((s) => Number(s));
  }
  throw new Error(
    `twap-detection: input_observation_ids has unexpected shape ${typeof value}`,
  );
}
