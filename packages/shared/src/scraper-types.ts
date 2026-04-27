import { z } from "zod";
import type { AvailabilityTier } from "./availability";
import type { Numeric } from "./numeric";

/**
 * Unified return shape from every per-supplier scraper module.
 *
 * Each module is "pure" — it fetches, parses, and returns this struct. It
 * does NOT call Supabase, compute USD/mg, or touch the run row. The runner
 * (apps/scraper/src/run.ts) handles:
 *   - currency → USD conversion (via FX rates fetched once per cycle)
 *   - mass diff vs. supplier_products.mass_per_unit_mg
 *   - inserting supplier_observations
 *   - diffing availability_tier against the previous observation and
 *     emitting availability_events on change
 *
 * Failure rows: every row has scrape_success. On failure, raw_* and
 * mass_mg may be null and scrape_error / http_status describe the failure.
 * The runner still inserts the row so we keep an audit trail of outages.
 */
export interface ScrapeResult {
  raw_price: Numeric | null;
  raw_currency: string | null;
  raw_availability: string | null;
  availability_tier: AvailabilityTier;
  lead_time_days: number | null;
  mass_mg: Numeric | null;
  raw_html_hash: string | null;
  http_status: number | null;
  scrape_success: boolean;
  scrape_error: string | null;
}

const numericString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a decimal numeric string")
  .nullable();

const availabilityTier: z.ZodType<AvailabilityTier> = z.enum([
  "in_stock",
  "low_stock",
  "lead_time",
  "out_of_stock",
  "discontinued",
  "unknown",
]);

/**
 * Strict zod schema for runtime validation. The runner pipes every supplier
 * module's return value through this before inserting, so a buggy module
 * cannot poison the DB with a misshapen row.
 */
export const scrapeResultSchema: z.ZodType<ScrapeResult> = z.object({
  raw_price: numericString,
  raw_currency: z.string().min(1).max(8).nullable(),
  raw_availability: z.string().nullable(),
  availability_tier: availabilityTier,
  lead_time_days: z.number().int().nonnegative().nullable(),
  mass_mg: numericString,
  raw_html_hash: z.string().nullable(),
  http_status: z.number().int().nullable(),
  scrape_success: z.boolean(),
  scrape_error: z.string().nullable(),
});
