import {
  type AdminClient,
  createAdminClient,
  type Numeric,
} from "@peptidefi/shared";
import { computeTwap, type TwapInput } from "./twap";
import { insertPeptideTwap, logOutliers } from "./persist";

/**
 * Single TWAP cycle. For each is_active=true peptide:
 *   1. Pull successful supplier_observations from the last
 *      WORKER_TWAP_WINDOW_MS (default 5 min) where price_usd_per_mg is
 *      non-null and the peptide is active and the supplier is active.
 *   2. Reduce to "most recent successful observation per supplier" inside
 *      the window.
 *   3. Hand the reduced set to computeTwap() — it returns either a
 *      computed TWAP (with kept/dropped observations + max deviation) or
 *      a thin-data signal when fewer than 2 suppliers reported.
 *   4. Persist a peptide_twaps row regardless of the outcome — thin-data
 *      cases write twap_usd_per_mg=NULL as an honest audit signal. Dropped
 *      outliers also write to outlier_log.
 *
 * Idempotency: computed_at is rounded to the start of the current UTC minute,
 * and peptide_twaps has unique (peptide_id, computed_at). Re-running inside
 * the same minute is a no-op via upsert ignoreDuplicates.
 */

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export interface CycleSummary {
  peptidesProcessed: number;
  peptidesWithTwap: number;
  peptidesWithThinData: number;
  rowsInserted: number;
  rowsSkippedIdempotent: number;
  durationMs: number;
}

export async function runOnce(): Promise<CycleSummary> {
  const startedAt = Date.now();
  const supabase = createAdminClient();

  const windowMs = Number.parseInt(
    process.env.WORKER_TWAP_WINDOW_MS ?? String(DEFAULT_WINDOW_MS),
    10,
  );

  // Round computed_at to start-of-current-minute UTC for idempotency.
  const now = new Date();
  const computedAt = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      0,
      0,
    ),
  );
  const windowEnd = computedAt;
  const windowStart = new Date(computedAt.getTime() - windowMs);

  const peptides = await loadActivePeptides(supabase);

  let withTwap = 0;
  let withThinData = 0;
  let inserted = 0;
  let skipped = 0;

  for (const peptide of peptides) {
    const observations = await loadLatestObservationsPerSupplier(
      supabase,
      peptide.id,
      windowStart,
      windowEnd,
    );

    const result = computeTwap(observations);

    let rowInserted: boolean;
    if (result.kind === "thin_data") {
      withThinData += 1;
      rowInserted = await insertPeptideTwap(supabase, {
        peptide_id: peptide.id,
        computed_at: computedAt,
        window_start: windowStart,
        window_end: windowEnd,
        twap_usd_per_mg: null,
        suppliers_used: result.kept.length,
        suppliers_dropped: 0,
        median_deviation_bps: null,
        input_observation_ids: result.kept.map((o) => o.observationId),
        dropped_observation_ids: [],
      });
    } else {
      withTwap += 1;
      rowInserted = await insertPeptideTwap(supabase, {
        peptide_id: peptide.id,
        computed_at: computedAt,
        window_start: windowStart,
        window_end: windowEnd,
        twap_usd_per_mg: result.twap,
        suppliers_used: result.kept.length,
        suppliers_dropped: result.dropped.length,
        median_deviation_bps: result.medianDeviationBps,
        input_observation_ids: result.kept.map((o) => o.observationId),
        dropped_observation_ids: result.dropped.map((o) => o.observationId),
      });

      if (result.dropped.length > 0) {
        await logOutliers(supabase, {
          peptide_id: peptide.id,
          detectedAt: computedAt,
          medianValue: result.twap,
          dropped: result.dropped,
        });
      }
    }

    if (rowInserted) inserted += 1;
    else skipped += 1;
  }

  return {
    peptidesProcessed: peptides.length,
    peptidesWithTwap: withTwap,
    peptidesWithThinData: withThinData,
    rowsInserted: inserted,
    rowsSkippedIdempotent: skipped,
    durationMs: Date.now() - startedAt,
  };
}

interface PeptideRow {
  id: number;
  code: string;
}

async function loadActivePeptides(supabase: AdminClient): Promise<PeptideRow[]> {
  const { data, error } = await supabase
    .from("peptides")
    .select("id, code")
    .eq("is_active", true)
    .order("id", { ascending: true });
  if (error) throw new Error(`loadActivePeptides: ${error.message}`);
  return data ?? [];
}

/**
 * For one peptide and a [windowStart, windowEnd] interval, return at most
 * one TwapInput per supplier — the most recent successful observation
 * within the window with a non-null price.
 *
 * We pull all candidate rows ordered by observed_at DESC and keep the
 * first per supplier client-side. With ~6 active suppliers × 5 obs/window
 * = ~30 rows per query, this is cheap and avoids needing a window
 * function in PostgREST.
 */
async function loadLatestObservationsPerSupplier(
  supabase: AdminClient,
  peptideId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<TwapInput[]> {
  const { data, error } = await supabase
    .from("supplier_observations")
    .select("id, supplier_id, price_usd_per_mg, observed_at, suppliers!inner(status)")
    .eq("peptide_id", peptideId)
    .eq("scrape_success", true)
    .not("price_usd_per_mg", "is", null)
    .gte("observed_at", windowStart.toISOString())
    .lte("observed_at", windowEnd.toISOString())
    .order("observed_at", { ascending: false });

  if (error) throw new Error(`loadLatestObservationsPerSupplier: ${error.message}`);

  const seen = new Set<number>();
  const out: TwapInput[] = [];
  for (const row of data ?? []) {
    if (row.suppliers.status !== "active") continue;
    if (seen.has(row.supplier_id)) continue;
    seen.add(row.supplier_id);
    if (row.price_usd_per_mg === null) continue;
    out.push({
      observationId: row.id,
      supplierId: row.supplier_id,
      // numeric → string at the load boundary
      priceUsdPerMg: String(row.price_usd_per_mg) as Numeric,
    });
  }
  return out;
}
