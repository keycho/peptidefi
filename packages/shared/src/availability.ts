import type { Database } from "@peptide-oracle/db";

/** Re-export the enum from the generated Database type for convenience. */
export type AvailabilityTier =
  Database["public"]["Enums"]["availability_tier"];

export interface AvailabilityResult {
  tier: AvailabilityTier;
  /** Parsed lead time in business days when raw text mentions one. */
  leadTimeDays: number | null;
}

/**
 * Heuristic mapping of supplier-side availability strings to the project's
 * canonical availability_tier enum. Each pattern is conservative — anything
 * that doesn't match falls through to 'unknown' and we keep the raw string
 * in supplier_observations.raw_availability for later refinement.
 *
 * Patterns are checked in this order (most specific first):
 *   discontinued > out_of_stock > low_stock > lead_time > in_stock > unknown
 *
 * "Lead time" matches any phrasing that promises a future ship date — the
 * lead_time_days extractor pulls the first plausible day count, with a
 * "weeks → days" conversion when the unit is weeks.
 */
const PATTERNS: Array<{
  tier: AvailabilityTier;
  test: RegExp;
}> = [
  // discontinued — check first; some products say "discontinued, see X"
  { tier: "discontinued", test: /\b(discontinued|no longer (?:available|sold|stocked)|removed from catalog|delisted)\b/i },

  // out of stock — explicit
  { tier: "out_of_stock", test: /\b(out of stock|sold out|currently unavailable|temporarily unavailable|not in stock|not available)\b/i },

  // low stock — limited / few left
  { tier: "low_stock", test: /\b(low stock|limited (?:stock|availability)|only \d+ left|while supplies last|hurry|last few)\b/i },

  // lead time — anything with a future ship promise that implies waiting
  { tier: "lead_time", test: /\b(lead[- ]?time|backorder|ships?\s+in|ships?\s+within|available in \d+|deliver(?:y|s)\s+in|estimated (?:ship|delivery))\b/i },

  // in stock — explicit and "ready / available now / ships today"
  { tier: "in_stock", test: /\b(in stock|available (?:now|today)|ready to ship|ships? today|usually ships? within 24|same[- ]day|next[- ]day)\b/i },
];

const LEAD_TIME_RE =
  /(\d+(?:\s*[-–]\s*\d+)?)\s*(business\s+)?(week|day|wk|d)s?\b/i;

function parseLeadTimeDays(raw: string): number | null {
  const m = raw.match(LEAD_TIME_RE);
  if (!m) return null;
  // Take the upper bound of any range ("3-5 weeks" → 5).
  const numbers = m[1]!.split(/[-–]/).map((s) => parseInt(s.trim(), 10));
  const n = Math.max(...numbers.filter((x) => Number.isFinite(x)));
  if (!Number.isFinite(n)) return null;
  const unit = m[3]!.toLowerCase();
  return unit.startsWith("w") ? n * 7 : n;
}

export function mapAvailability(
  raw: string | null | undefined,
): AvailabilityResult {
  if (!raw) return { tier: "unknown", leadTimeDays: null };
  const text = raw.trim();
  if (text.length === 0) return { tier: "unknown", leadTimeDays: null };

  for (const { tier, test } of PATTERNS) {
    if (test.test(text)) {
      return {
        tier,
        leadTimeDays: tier === "lead_time" ? parseLeadTimeDays(text) : null,
      };
    }
  }
  return { tier: "unknown", leadTimeDays: null };
}
