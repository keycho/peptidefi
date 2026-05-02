import type { Observation } from "@peptide-oracle/shared";

/**
 * supabase-js row → canonical Observation adapter for the API.
 *
 * Why this is separate from the oracle's `rowToObservation`:
 *
 *   - The oracle uses postgres.js, which returns `numeric` as JS
 *     string by default and `bigint` as JS bigint. Its adapter throws
 *     hard when those types arrive as JS numbers (defensive — a
 *     misconfig would float-truncate prices).
 *
 *   - The API uses supabase-js (PostgREST), whose JSON-over-HTTP path
 *     can return numeric columns as either JS strings (preferred,
 *     preserves precision) or JS numbers (older clients, or certain
 *     query shapes). bigint columns come back as JS numbers
 *     (PostgREST clamps to JS-safe integer range).
 *
 * Fix for the API: accept either shape on numeric columns. If the
 * driver hands us a number, render via `toFixed(<schema-scale>)` so
 * the canonical string matches PG's text representation. The
 * schema scales are pinned per-column (`numeric(20,6)`,
 * `numeric(20,8)`) — they're locked at v=1 of the protocol.
 *
 * For values within JS Number's exact-integer range
 * (|n| < 2⁵³ ≈ 9×10¹⁵) the toFixed conversion is lossless. Our
 * production peptide prices are in the $0.001–$1000/mg range, well
 * within that bound.
 */

interface SupabaseObservationRow {
  id: number;
  supplier_id: number;
  peptide_id: number;
  supplier_product_id: number;
  scraper_run_id: number;
  observed_at: string;
  raw_price: string | number | null;
  raw_currency: string | null;
  fx_rate_to_usd: string | number | null;
  price_usd_per_mg: string | number | null;
  raw_availability: string | null;
  availability_tier: string;
  lead_time_days: number | null;
  scrape_success: boolean;
  scrape_error: string | null;
  http_status: number | null;
  raw_html_hash: string | null;
}

const SCALE_RAW_PRICE = 6; // numeric(20, 6) per migration 0004
const SCALE_FX = 8; // numeric(20, 8) per migration 0004
const SCALE_PRICE_USD_PER_MG = 6; // numeric(20, 6)

export function rowToObservationLike(row: SupabaseObservationRow): Observation {
  return {
    id: row.id,
    supplier_id: row.supplier_id,
    peptide_id: row.peptide_id,
    supplier_product_id: row.supplier_product_id,
    scraper_run_id: row.scraper_run_id,
    observed_at: canonicalTimestamp(row.observed_at, "observed_at"),
    raw_price: decimalToCanonical(row.raw_price, SCALE_RAW_PRICE, "raw_price"),
    raw_currency: row.raw_currency,
    fx_rate_to_usd: decimalToCanonical(
      row.fx_rate_to_usd,
      SCALE_FX,
      "fx_rate_to_usd",
    ),
    price_usd_per_mg: decimalToCanonical(
      row.price_usd_per_mg,
      SCALE_PRICE_USD_PER_MG,
      "price_usd_per_mg",
    ),
    raw_availability: row.raw_availability,
    availability_tier: row.availability_tier,
    lead_time_days: row.lead_time_days,
    scrape_success: row.scrape_success,
    scrape_error: row.scrape_error,
    http_status: row.http_status,
    raw_html_hash: row.raw_html_hash,
  };
}

function decimalToCanonical(
  value: string | number | null,
  scale: number,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    // Trust PostgREST's string form as canonical; assume it already
    // matches the column's scale (PG renders fixed-scale numerics
    // with exactly that many decimal places).
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} is non-finite number: ${value}`);
    }
    return value.toFixed(scale);
  }
  throw new Error(`${field} unexpected type ${typeof value}`);
}

function canonicalTimestamp(value: string, field: string): string {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) {
    throw new Error(`${field} is an invalid date: "${value}"`);
  }
  return d.toISOString();
}
