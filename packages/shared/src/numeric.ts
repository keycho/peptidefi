import BigNumber from "bignumber.js";

/**
 * Postgres-friendly decimal math.
 *
 * Postgres returns `numeric(...)` columns as strings to preserve precision —
 * we parse them with BigNumber and never let JavaScript `Number` touch a
 * money value. Output is always a plain string (decimal notation, no
 * exponential, fixed scale where specified) so re-inserting into Postgres
 * round-trips losslessly.
 *
 * Default scale here is 6 decimal places, which matches numeric(20, 6) used
 * across the schema for points, masses, and per-mg prices. For AMM reserves
 * (numeric(40, 18)) call divide/multiply with dp=18.
 */

BigNumber.config({
  EXPONENTIAL_AT: 1e9,
  DECIMAL_PLACES: 40,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
});

/** A numeric value as Postgres returns it: decimal string, no exponent. */
export type Numeric = string;

/** Lift any input to BigNumber for math. */
export function bn(v: Numeric | number | BigNumber): BigNumber {
  if (BigNumber.isBigNumber(v)) return v;
  return new BigNumber(v);
}

/** Render a BigNumber back to a Postgres-shaped string at the given scale. */
export function toNumeric(v: BigNumber | Numeric | number, dp = 6): Numeric {
  return bn(v).toFixed(dp);
}

export function add(a: Numeric, b: Numeric, dp = 6): Numeric {
  return toNumeric(bn(a).plus(b), dp);
}

export function subtract(a: Numeric, b: Numeric, dp = 6): Numeric {
  return toNumeric(bn(a).minus(b), dp);
}

export function multiply(a: Numeric, b: Numeric, dp = 6): Numeric {
  return toNumeric(bn(a).times(b), dp);
}

export function divide(a: Numeric, b: Numeric, dp = 6): Numeric {
  const bb = bn(b);
  if (bb.isZero()) throw new Error("divide by zero");
  return toNumeric(bn(a).div(bb), dp);
}

export function isZero(v: Numeric): boolean {
  return bn(v).isZero();
}

export function isPositive(v: Numeric): boolean {
  return bn(v).isPositive() && !bn(v).isZero();
}

/**
 * Percentage difference of `a` and `b` relative to `a`, as a regular Number
 * (not Numeric — small magnitudes, used only for comparison + logging).
 *
 * Returns Infinity when `a` is zero and `b` is non-zero, 0 when both are
 * zero. Sign is dropped — caller uses |delta| > threshold style checks.
 *
 * Used by the scraper to detect when a supplier's parsed mass drifts more
 * than 5% from the stored mass_per_unit_mg, which fires a
 * "MASS_CHANGE_DETECTED" warning.
 */
export function pctDiff(a: Numeric, b: Numeric): number {
  const aBn = bn(a);
  const bBn = bn(b);
  if (aBn.isZero() && bBn.isZero()) return 0;
  if (aBn.isZero()) return Number.POSITIVE_INFINITY;
  return aBn.minus(bBn).abs().div(aBn).times(100).toNumber();
}

/**
 * Median of a non-empty list of Numeric values. For an even count, returns
 * the arithmetic mean of the two middle elements (standard median).
 *
 * Used by the TWAP worker to compute the cross-supplier canonical price
 * each cycle. Throws on empty input — callers must short-circuit when
 * there's nothing to median.
 *
 * Returned scale defaults to 6 (matches numeric(20, 6) on
 * peptide_twaps.twap_usd_per_mg). Callers writing into wider columns can
 * pass a higher dp.
 */
export function median(values: Numeric[], dp = 6): Numeric {
  if (values.length === 0) {
    throw new Error("median: empty input");
  }
  const sorted = values.map(bn).sort((a, b) => a.comparedTo(b) ?? 0);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return toNumeric(sorted[mid]!, dp);
  }
  const lo = sorted[mid - 1]!;
  const hi = sorted[mid]!;
  return toNumeric(lo.plus(hi).div(2), dp);
}
