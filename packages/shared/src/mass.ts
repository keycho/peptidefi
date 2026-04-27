import { bn, toNumeric, type Numeric } from "./numeric";

/**
 * Parse a free-form mass string into milligrams.
 *
 * Supported units (case-insensitive):
 *   kg, g, mg, μg / µg / ug / mcg
 *
 * Recognised forms:
 *   "1 mg", "1mg", "1.0 mg"
 *   "100 µg", "100mcg"
 *   "0.5 g", "1 g", "2.5g"
 *   "1 kg"
 *   "5 mg / vial", "1 mg per ampoule"  (anything after the unit is ignored)
 *
 * Returns null if no plausible quantity+unit pair is found, so the caller
 * falls back to supplier_products.mass_per_unit_mg.
 *
 * Returns a numeric(20, 6) string. The scraper inserts the parsed mass on
 * every successful scrape and updates supplier_products.mass_per_unit_mg in
 * place; if the new value drifts >5% from the stored one we log
 * MASS_CHANGE_DETECTED but follow the supplier either way (per spec).
 */
const MASS_RE =
  /(\d+(?:[.,]\d+)?)\s*(kg|g|mg|μg|µg|ug|mcg)\b/i;

export function parseMassToMg(input: string): Numeric | null {
  if (!input) return null;
  const match = input.match(MASS_RE);
  if (!match) return null;

  const value = bn(match[1]!.replace(",", "."));
  const unit = match[2]!.toLowerCase();

  switch (unit) {
    case "kg":
      return toNumeric(value.times(1_000_000));
    case "g":
      return toNumeric(value.times(1000));
    case "mg":
      return toNumeric(value);
    case "μg":
    case "µg":
    case "ug":
    case "mcg":
      return toNumeric(value.div(1000));
    default:
      return null;
  }
}
