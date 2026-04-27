import {
  bn,
  median,
  toNumeric,
  type Numeric,
} from "@peptidefi/shared";

/**
 * Cross-supplier TWAP computation, per-peptide, per-cycle.
 *
 * Inputs: the most-recent successful supplier_observation per supplier
 * inside the configured window. Caller is responsible for the SQL
 * "latest per supplier" reduction.
 *
 * Algorithm (as confirmed by user):
 *   1. If fewer than 2 reporting suppliers → no TWAP. Return a thin-data
 *      result so the caller can persist a NULL audit row instead of
 *      fabricating a single-supplier "TWAP".
 *   2. If 2 suppliers → median = arithmetic mean. No outlier filtering
 *      (would always drop one of the two).
 *   3. If 3+ suppliers → compute cross-supplier median; drop any obs
 *      whose price deviates more than 5% from that median; recompute
 *      median over the kept set as the canonical TWAP. Dropped rows
 *      are logged via outlier_log by the caller.
 *
 * median_deviation_bps is the maximum |obs - median| / median expressed in
 * basis points across the KEPT observations. Diagnostic only.
 */

const OUTLIER_THRESHOLD_PCT = 0.05; // 5% per spec

export interface TwapInput {
  /** supplier_observation.id */
  observationId: number;
  /** supplier_observation.supplier_id */
  supplierId: number;
  /** supplier_observation.price_usd_per_mg as Numeric string */
  priceUsdPerMg: Numeric;
}

export type TwapResult =
  | {
      kind: "computed";
      twap: Numeric;
      kept: TwapInput[];
      dropped: TwapInput[];
      medianDeviationBps: number | null;
    }
  | {
      kind: "thin_data";
      reason: "no_suppliers" | "single_supplier";
      kept: TwapInput[];
    };

export function computeTwap(observations: TwapInput[]): TwapResult {
  if (observations.length === 0) {
    return { kind: "thin_data", reason: "no_suppliers", kept: [] };
  }
  if (observations.length === 1) {
    return {
      kind: "thin_data",
      reason: "single_supplier",
      kept: observations,
    };
  }

  if (observations.length === 2) {
    // Two-supplier case: arithmetic mean (== median for n=2). No outliers.
    const med = median(observations.map((o) => o.priceUsdPerMg));
    const deviation = maxDeviationBps(observations, med);
    return {
      kind: "computed",
      twap: med,
      kept: observations,
      dropped: [],
      medianDeviationBps: deviation,
    };
  }

  // 3+ suppliers: outlier-aware
  const seedPrices = observations.map((o) => o.priceUsdPerMg);
  const seedMedian = median(seedPrices);
  const threshold = bn(seedMedian).times(OUTLIER_THRESHOLD_PCT);

  const kept: TwapInput[] = [];
  const dropped: TwapInput[] = [];
  for (const obs of observations) {
    const deviation = bn(obs.priceUsdPerMg).minus(seedMedian).abs();
    if (deviation.gt(threshold)) {
      dropped.push(obs);
    } else {
      kept.push(obs);
    }
  }

  // Defensive: if EVERY supplier was an outlier (shouldn't happen with a
  // 5% threshold around their own median, but algebraic edge cases exist
  // when prices are clustered far from the median), fall back to no-drop.
  if (kept.length === 0) {
    const dev = maxDeviationBps(observations, seedMedian);
    return {
      kind: "computed",
      twap: seedMedian,
      kept: observations,
      dropped: [],
      medianDeviationBps: dev,
    };
  }

  // Recompute median over kept set for the final TWAP.
  const finalTwap = median(kept.map((o) => o.priceUsdPerMg));
  const dev = maxDeviationBps(kept, finalTwap);
  return {
    kind: "computed",
    twap: finalTwap,
    kept,
    dropped,
    medianDeviationBps: dev,
  };
}

/**
 * Max |obs - reference| / reference among the inputs, in basis points.
 * Returns null when reference is zero (degenerate prices).
 */
function maxDeviationBps(
  inputs: TwapInput[],
  reference: Numeric,
): number | null {
  const ref = bn(reference);
  if (ref.isZero()) return null;
  let max = 0;
  for (const o of inputs) {
    const dev = bn(o.priceUsdPerMg).minus(ref).abs().div(ref).times(10_000);
    const n = dev.toNumber();
    if (Number.isFinite(n) && n > max) max = n;
  }
  return Math.round(max);
}

/** Re-export for convenience in tests / callers. */
export { OUTLIER_THRESHOLD_PCT };
export const _internal = { maxDeviationBps };
