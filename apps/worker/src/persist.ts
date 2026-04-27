import { type AdminClient, type Numeric } from "@peptidefi/shared";
import type { TwapInput } from "./twap";

/**
 * peptide_twaps + outlier_log writes for the TWAP worker.
 *
 * Idempotency: peptide_twaps has unique (peptide_id, computed_at). The
 * worker rounds computed_at to the start of the minute (UTC), so re-running
 * within the same minute hits the same key and is a no-op via
 * ON CONFLICT DO NOTHING. Different minute → new row.
 *
 * Numeric handling: same supabase-gen-types convention as the scraper —
 * Postgres numeric columns come back to JS as `number`. We convert
 * Numeric → number at the insert boundary; magnitudes for prices and
 * percentages comfortably fit Number's 15 sigfigs.
 */

interface PeptideTwapInsert {
  peptide_id: number;
  computed_at: Date;
  window_start: Date;
  window_end: Date;
  twap_usd_per_mg: Numeric | null;
  suppliers_used: number;
  suppliers_dropped: number;
  median_deviation_bps: number | null;
  input_observation_ids: number[];
  dropped_observation_ids: number[];
}

function numToNumber(v: Numeric | null): number | null {
  return v === null ? null : Number(v);
}

/**
 * Write the per-peptide-per-cycle TWAP row. Returns true when a new row
 * was inserted; false when the row already exists for this minute (the
 * idempotency case).
 */
export async function insertPeptideTwap(
  supabase: AdminClient,
  args: PeptideTwapInsert,
): Promise<boolean> {
  const { error, count } = await supabase
    .from("peptide_twaps")
    .upsert(
      {
        peptide_id: args.peptide_id,
        computed_at: args.computed_at.toISOString(),
        window_start: args.window_start.toISOString(),
        window_end: args.window_end.toISOString(),
        twap_usd_per_mg: numToNumber(args.twap_usd_per_mg),
        suppliers_used: args.suppliers_used,
        suppliers_dropped: args.suppliers_dropped,
        median_deviation_bps: args.median_deviation_bps,
        input_observation_ids: args.input_observation_ids,
        dropped_observation_ids: args.dropped_observation_ids,
      },
      { onConflict: "peptide_id,computed_at", ignoreDuplicates: true, count: "exact" },
    );

  if (error) throw new Error(`insertPeptideTwap: ${error.message}`);
  // upsert with ignoreDuplicates returns count=1 on insert, 0 on conflict.
  return (count ?? 0) > 0;
}

/**
 * Log dropped observations to outlier_log. One row per dropped observation
 * with the cross-supplier median that the observation deviated from.
 */
export async function logOutliers(
  supabase: AdminClient,
  args: {
    peptide_id: number;
    detectedAt: Date;
    medianValue: Numeric;
    dropped: TwapInput[];
  },
): Promise<void> {
  if (args.dropped.length === 0) return;

  const medianNum = Number(args.medianValue);
  const rows = args.dropped.map((o) => {
    const observed = Number(o.priceUsdPerMg);
    const deviationBps =
      medianNum > 0
        ? Math.round((Math.abs(observed - medianNum) / medianNum) * 10_000)
        : null;
    return {
      peptide_id: args.peptide_id,
      supplier_id: o.supplierId,
      supplier_observation_id: o.observationId,
      supplier_twap_id: null,
      detected_at: args.detectedAt.toISOString(),
      reason: ">5% from cross-supplier median",
      deviation_bps: deviationBps,
      median_value: medianNum,
      observed_value: observed,
    };
  });

  const { error } = await supabase.from("outlier_log").insert(rows);
  if (error) throw new Error(`logOutliers: ${error.message}`);
}
