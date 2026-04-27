import { bn, toNumeric, type Numeric } from "./numeric";

/**
 * Convert a raw supplier price into USD per milligram.
 *
 *   price_usd_per_mg = (raw_price_in_currency × fx_rate_to_usd) / mass_mg
 *
 * fxRateToUsd is "multiply local currency by this to get USD"
 * (e.g. CHF × 1.0989 → USD). When fxRateToUsd is null (FX provider outage)
 * we return null — the scraper still writes the raw_price/raw_currency
 * row but with a null price_usd_per_mg, per spec.
 *
 * Returns a numeric(20, 6) string ready to insert into supplier_observations.
 */
export function computePriceUsdPerMg(
  rawPrice: Numeric | null,
  fxRateToUsd: Numeric | null,
  massMg: Numeric | null,
): Numeric | null {
  if (rawPrice === null || fxRateToUsd === null || massMg === null) {
    return null;
  }
  const mass = bn(massMg);
  if (mass.isZero() || mass.isNegative()) return null;
  const usdTotal = bn(rawPrice).times(fxRateToUsd);
  return toNumeric(usdTotal.div(mass), 6);
}
