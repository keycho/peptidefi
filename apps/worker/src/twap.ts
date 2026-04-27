import { bn, median, type Numeric } from "@peptidefi/shared";

/**
 * Cross-supplier TWAP computation, per-peptide, per-cycle.
 *
 * Inputs: the most-recent successful supplier_observation per supplier
 * inside the configured window. Caller is responsible for the SQL
 * "latest per supplier" reduction.
 *
 * v1 algorithm — straight median, no outlier filtering:
 *   - n=0  → thin_data (no_suppliers).
 *   - n=1  → thin_data (single_supplier). Honest signal beats a fake
 *             single-supplier "consensus".
 *   - n≥2  → median across all valid observations. Done.
 *
 * Why no outlier filter in v1:
 *   The consumer peptide market genuinely has 2-3× spreads between vendors.
 *   That spread is a feature of the market, not noise. A 5% threshold
 *   drops legitimate observations and synthesises fake consensus from
 *   1-2 survivors. The median is already robust to extreme values; that's
 *   the whole point of using median over mean. Stacking outlier filtering
 *   on top of the median is over-engineering for our actual data shape.
 *
 *   Schema columns dropped_observation_ids and outlier_log are kept in
 *   place — when we revisit (likely with MAD-based filtering after v1),
 *   we won't need a migration to re-enable.
 *
 * median_deviation_bps stays populated as a diagnostic — max
 * |obs − median| / median across the kept set, in basis points. High
 * values are informational, not action items.
 */

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

  // n ≥ 2: straight median, every observation kept. dropped is always [].
  const twap = median(observations.map((o) => o.priceUsdPerMg));
  const deviation = maxDeviationBps(observations, twap);
  return {
    kind: "computed",
    twap,
    kept: observations,
    dropped: [],
    medianDeviationBps: deviation,
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

export const _internal = { maxDeviationBps };
