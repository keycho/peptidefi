/**
 * Canonical observation form per §02.4.2.
 *
 * Pure module: takes an Observation already in canonical types (decimals
 * as strings per §02.5, timestamps as 24-char ms-precision UTC ISO
 * strings per §02.6) and produces the byte-exact JSON that gets hashed
 * into a Merkle leaf.
 *
 * Adapter code that reads from Postgres + converts numeric/timestamp
 * column types into this shape lives separately (Phase B).
 *
 * Determinism guarantees:
 *   - Sorted keys, alphabetic ascending — same key order across all
 *     JS engines.
 *   - No whitespace (default JSON.stringify separators).
 *   - Every one of the 17 fields ALWAYS present; nulls allowed but
 *     undefined throws (§02.2.7 NULL handling).
 */

export interface Observation {
  id: number;
  supplier_id: number;
  peptide_id: number;
  supplier_product_id: number;
  scraper_run_id: number;
  /** ISO 8601 UTC, ms precision, exactly 24 chars (§02.6). */
  observed_at: string;
  /** Decimal string per §02.5, or null. */
  raw_price: string | null;
  raw_currency: string | null;
  /** Decimal string per §02.5, or null. */
  fx_rate_to_usd: string | null;
  /** Decimal string per §02.5, or null. */
  price_usd_per_mg: string | null;
  raw_availability: string | null;
  /** Enum value (in_stock | out_of_stock | unknown), always present. */
  availability_tier: string;
  lead_time_days: number | null;
  scrape_success: boolean;
  scrape_error: string | null;
  http_status: number | null;
  raw_html_hash: string | null;
}

/**
 * The 17 leaf fields in canonical (sorted-ascending) order. Locked at v=1
 * per §02.2.4; any change requires a protocol bump.
 */
export const OBSERVATION_FIELDS = [
  "availability_tier",
  "fx_rate_to_usd",
  "http_status",
  "id",
  "lead_time_days",
  "observed_at",
  "peptide_id",
  "price_usd_per_mg",
  "raw_availability",
  "raw_currency",
  "raw_html_hash",
  "raw_price",
  "scrape_error",
  "scrape_success",
  "scraper_run_id",
  "supplier_id",
  "supplier_product_id",
] as const;

/**
 * Build the canonical UTF-8 JSON form of an observation.
 *
 * Rebuilds the object with explicit insertion order rather than relying
 * on JSON.stringify's third "replacer" parameter. Avoids subtle bugs
 * around keys that exist on the input but aren't in our list (the
 * replacer-array form silently drops them, which would mask a "rogue
 * field on the input row" bug).
 *
 * Throws on:
 *   - missing field (the input row is incomplete)
 *   - undefined field value (use null for absent values per §02.2.7)
 */
export function canonicalObservationJson(obs: Observation): string {
  const ordered: Record<string, unknown> = {};
  for (const field of OBSERVATION_FIELDS) {
    if (!(field in obs)) {
      throw new Error(
        `canonical: observation is missing required field "${field}"`,
      );
    }
    const value = (obs as Record<string, unknown>)[field];
    if (value === undefined) {
      throw new Error(
        `canonical: observation field "${field}" is undefined; ` +
          `use null for absent values (§02.2.7 NULL handling)`,
      );
    }
    ordered[field] = value;
  }
  return JSON.stringify(ordered);
}
