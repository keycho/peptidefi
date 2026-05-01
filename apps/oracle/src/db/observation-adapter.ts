import type { Observation } from "../canonical";

/**
 * PG row → canonical Observation adapter.
 *
 * Pure function: takes the row shape that the `postgres` library returns
 * for a `SELECT * FROM supplier_observations` and produces an
 * Observation in canonical form per §02.4.2.
 *
 * The two transforms that matter:
 *
 *   - **Timestamps** (§02.6): PG returns timestamptz as a JS Date when
 *     using the `postgres` library, or as a string with timezone offset
 *     ("2026-05-01T12:00:00.123456+00:00") via supabase-js. We re-render
 *     to canonical 24-char ms-precision UTC ISO ("2026-05-01T12:00:00.123Z")
 *     using Date#toISOString() — which truncates to ms (matches §02.6
 *     "truncate, not round" rule).
 *
 *   - **Decimals** (§02.5): PG `numeric` columns must arrive as JS strings
 *     to preserve precision. The `postgres` library returns numeric as
 *     string by default; we validate and pass through. If a numeric ever
 *     arrives as a JS number (driver misconfig), we throw — silently
 *     converting via String() could float-truncate.
 *
 * Caller responsibility: the SELECT must include all 17 fields the
 * canonical leaf hash covers. Missing columns surface here as adapter
 * errors rather than silently null-filling.
 */

/**
 * The shape `postgres` returns from a `SELECT * FROM supplier_observations`
 * row, before adapter transformation.
 *
 * Decimal columns are typed as string (the `postgres` library's default
 * for `numeric`); timestamp columns are typed as Date (the library
 * parses these by default).
 */
export interface SupplierObservationRow {
  id: number | bigint;
  supplier_id: number | bigint;
  peptide_id: number | bigint;
  supplier_product_id: number | bigint;
  scraper_run_id: number | bigint;
  observed_at: Date | string;
  raw_price: string | null;
  raw_currency: string | null;
  fx_rate_to_usd: string | null;
  price_usd_per_mg: string | null;
  raw_availability: string | null;
  availability_tier: string;
  lead_time_days: number | null;
  scrape_success: boolean;
  scrape_error: string | null;
  http_status: number | null;
  raw_html_hash: string | null;
}

/**
 * Convert a single PG row into the canonical Observation form.
 *
 * Throws on:
 *   - Numeric columns arriving as JS numbers (driver misconfig — would
 *     risk float precision loss).
 *   - Timestamps that fail to parse.
 *   - Bigint id values that exceed JS safe integer range (we don't
 *     handle that case in v1 per §02.4.2 protocol limits).
 */
export function rowToObservation(row: SupplierObservationRow): Observation {
  return {
    id: bigintToNumber(row.id, "id"),
    supplier_id: bigintToNumber(row.supplier_id, "supplier_id"),
    peptide_id: bigintToNumber(row.peptide_id, "peptide_id"),
    supplier_product_id: bigintToNumber(
      row.supplier_product_id,
      "supplier_product_id",
    ),
    scraper_run_id: bigintToNumber(row.scraper_run_id, "scraper_run_id"),
    observed_at: canonicalTimestamp(row.observed_at, "observed_at"),
    raw_price: passThroughDecimal(row.raw_price, "raw_price"),
    raw_currency: row.raw_currency,
    fx_rate_to_usd: passThroughDecimal(row.fx_rate_to_usd, "fx_rate_to_usd"),
    price_usd_per_mg: passThroughDecimal(row.price_usd_per_mg, "price_usd_per_mg"),
    raw_availability: row.raw_availability,
    availability_tier: row.availability_tier,
    lead_time_days: row.lead_time_days,
    scrape_success: row.scrape_success,
    scrape_error: row.scrape_error,
    http_status: row.http_status,
    raw_html_hash: row.raw_html_hash,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Convert a PG bigint to a JS number, throwing if it would exceed
 * Number.MAX_SAFE_INTEGER. v1 protocol expects integer ids fit in
 * 2^53 (per §02.4.2 implementation note); a future v2 with strings
 * would loosen this.
 */
function bigintToNumber(value: number | bigint, field: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`adapter: ${field} expected integer, got ${value}`);
    }
    return value;
  }
  if (typeof value === "bigint") {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new Error(
        `adapter: ${field} bigint ${value} exceeds JS safe integer range; ` +
          `protocol v1 requires ids < 2^53 (§02.4.2)`,
      );
    }
    return Number(value);
  }
  throw new Error(`adapter: ${field} expected number/bigint, got ${typeof value}`);
}

/**
 * Format a PG timestamp into the §02.6 canonical form: 24-char UTC ISO
 * with millisecond precision, "Z" suffix.
 *
 * Date#toISOString() returns exactly that format. Sub-millisecond
 * precision in the source (PG timestamptz can store microseconds) is
 * truncated when constructing the JS Date, which matches §02.6's
 * "truncate, not round" rule.
 */
export function canonicalTimestamp(
  value: Date | string,
  field: string,
): string {
  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === "string") {
    d = new Date(value);
  } else {
    throw new Error(`adapter: ${field} expected Date or string, got ${typeof value}`);
  }
  if (!Number.isFinite(d.getTime())) {
    throw new Error(`adapter: ${field} is an invalid date: "${String(value)}"`);
  }
  return d.toISOString();
}

/**
 * Trust PG's text representation of numeric values (per §02.5 "the
 * canonical string form is exactly what Postgres returns for
 * column::text"). Throws if the driver returned a JS number — that
 * would imply float conversion happened somewhere upstream and the
 * stored precision may already be corrupted.
 */
function passThroughDecimal(
  value: string | null,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(
      `adapter: ${field} expected string (preserves numeric precision per §02.5) ` +
        `but got ${typeof value}: ${String(value)}. ` +
        `If using the postgres library, confirm numeric is parsed as string.`,
    );
  }
  return value;
}
