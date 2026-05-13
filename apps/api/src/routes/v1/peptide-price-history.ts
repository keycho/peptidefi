import type { Request, Response } from "express";
import { z } from "zod";
import { adminClientUntyped } from "../../supabase";
import { sendError } from "../../errors";

/**
 * GET /v1/peptides/:code/price-history
 *
 * Per-vendor price history for a peptide, aggregated into daily or
 * hourly buckets, with the TWAP series over the same window. Powers
 * historical-trajectory visualizations (e.g. BioHash Oracle Lab) and
 * any consumer wanting more than the current-snapshot view that
 * /vendor-prices already exposes.
 *
 * Query parameters:
 *   :code         — peptide code, normalised to upper case
 *   ?days         — window length in days; default 14, max 90
 *   ?aggregation  — 'daily' | 'hourly'; default 'daily'
 *   ?vendor       — optional vendor code filter (matches suppliers.code)
 *
 * Aggregation is performed JS-side. PostgREST does not surface
 * Postgres' date_trunc grouping through the supabase-js client, and
 * adding a server-side aggregate RPC is heavier than it's worth at
 * current volumes — a 90-day × 11-vendor × hourly request resolves
 * to ~24k rows, which Supabase returns in a single page.
 *
 * Cache: public, max-age=300. Underlying observation cadence is
 * 30 minutes (oracle TWAP window), so a 5-minute CDN slice adds at
 * most ~16% staleness to the freshest bucket — acceptable for a
 * history endpoint.
 */

const CODE_RE = /^[A-Z0-9]{2,16}$/;
const VENDOR_CODE_RE = /^[A-Z0-9_]{2,32}$/;

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
  aggregation: z.enum(["daily", "hourly"]).default("daily"),
  vendor: z
    .string()
    .trim()
    .toUpperCase()
    .regex(VENDOR_CODE_RE)
    .optional(),
});

interface ObservationRow {
  supplier_id: number | string;
  price_usd_per_mg: string | number;
  observed_at: string;
  suppliers:
    | { code: string; display_name: string }
    | { code: string; display_name: string }[]
    | null;
}

interface TwapRow {
  twap_value: string | number;
  computed_at: string;
}

interface VendorPoint {
  timestamp: string;
  price_usd_per_mg: number;
  observation_count: number;
}

interface VendorSeries {
  vendor_code: string;
  vendor_display_name: string;
  points: VendorPoint[];
}

interface TwapPoint {
  timestamp: string;
  twap_value_usd_per_mg: number;
  cycle_count: number;
}

export async function getPeptidePriceHistoryHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const codeParam = (req.params.code ?? "").trim().toUpperCase();
  if (!CODE_RE.test(codeParam)) {
    sendError(
      res,
      400,
      "BAD_REQUEST",
      "code must be 2–16 uppercase alphanumeric characters",
    );
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return;
  }
  const { days, aggregation, vendor } = parsed.data;

  const supabase = adminClientUntyped();

  // 1. Resolve :code → peptide row (404 if missing).
  const { data: peptide, error: pErr } = await supabase
    .from("peptides")
    .select("id, code, display_name")
    .eq("code", codeParam)
    .maybeSingle();
  if (pErr) {
    sendError(res, 500, "DB_ERROR", `peptide lookup failed: ${pErr.message}`);
    return;
  }
  if (!peptide) {
    sendError(res, 404, "NOT_FOUND", `peptide not found: ${codeParam}`);
    return;
  }

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);

  // 2. Optional vendor filter → resolve to supplier id so the
  // downstream observation query stays index-friendly.
  let vendorSupplierId: number | string | null = null;
  let vendorSupplierMeta: { code: string; display_name: string } | null = null;
  if (vendor !== undefined) {
    const { data: supplierRow, error: sErr } = await supabase
      .from("suppliers")
      .select("id, code, display_name")
      .eq("code", vendor)
      .maybeSingle();
    if (sErr) {
      sendError(res, 500, "DB_ERROR", `vendor lookup failed: ${sErr.message}`);
      return;
    }
    if (!supplierRow) {
      sendError(res, 404, "NOT_FOUND", `vendor not found: ${vendor}`);
      return;
    }
    vendorSupplierId = supplierRow.id;
    vendorSupplierMeta = {
      code: supplierRow.code,
      display_name: supplierRow.display_name,
    };
  }

  // 3. Observations in window. Vendor join keeps the display name +
  // code lookup in one round-trip.
  let obsQuery = supabase
    .from("supplier_observations")
    .select(
      "supplier_id, price_usd_per_mg, observed_at, suppliers(code, display_name)",
    )
    .eq("peptide_id", peptide.id)
    .eq("scrape_success", true)
    .not("price_usd_per_mg", "is", null)
    .gte("observed_at", windowStart.toISOString())
    .lte("observed_at", windowEnd.toISOString())
    .order("observed_at", { ascending: true });
  if (vendorSupplierId !== null) {
    obsQuery = obsQuery.eq("supplier_id", vendorSupplierId);
  }
  const { data: obsRows, error: oErr } = await obsQuery;
  if (oErr) {
    sendError(
      res,
      500,
      "DB_ERROR",
      `supplier_observations query failed: ${oErr.message}`,
    );
    return;
  }

  // 4. TWAP commits in window — used for the twap_series block.
  const { data: twapRows, error: tErr } = await supabase
    .from("twap_commits")
    .select("twap_value, computed_at")
    .eq("peptide_code", peptide.code)
    .eq("status", "finalized")
    .gte("computed_at", windowStart.toISOString())
    .lte("computed_at", windowEnd.toISOString())
    .order("computed_at", { ascending: true });
  if (tErr) {
    sendError(
      res,
      500,
      "DB_ERROR",
      `twap_commits query failed: ${tErr.message}`,
    );
    return;
  }

  // 5. Aggregate JS-side.
  const vendorSeriesList = aggregateVendorSeries(
    (obsRows ?? []) as ObservationRow[],
    aggregation,
  );
  const twapSeriesOut = aggregateTwapSeries(
    (twapRows ?? []) as TwapRow[],
    aggregation,
  );

  // If a vendor filter was requested but no observations landed in
  // the window, return an empty series for that vendor rather than
  // an empty list — clients should know the vendor is recognised.
  if (vendorSupplierMeta && vendorSeriesList.length === 0) {
    vendorSeriesList.push({
      vendor_code: vendorSupplierMeta.code,
      vendor_display_name: vendorSupplierMeta.display_name,
      points: [],
    });
  }

  res.set("Cache-Control", "public, max-age=300, s-maxage=300");
  res.json({
    peptide_code: peptide.code,
    peptide_display_name: peptide.display_name,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    aggregation,
    vendors: vendorSeriesList,
    twap_series: twapSeriesOut,
  });
}

/* ─── Aggregation helpers ──────────────────────────────────────── */

/**
 * Buckets observations by (supplier_id, time-truncated bucket) and
 * averages the price per bucket. Returns one series per supplier,
 * sorted by vendor display name (ascending) so the wire ordering is
 * stable across requests with the same data.
 */
function aggregateVendorSeries(
  rows: ObservationRow[],
  aggregation: "daily" | "hourly",
): VendorSeries[] {
  type SupplierKey = string | number;
  interface BucketAcc {
    sum: number;
    count: number;
  }
  // supplier -> bucketISO -> {sum, count}
  const bySupplier = new Map<
    SupplierKey,
    {
      code: string;
      display_name: string;
      buckets: Map<string, BucketAcc>;
    }
  >();

  for (const row of rows) {
    const supplier = extractSupplier(row.suppliers);
    if (!supplier) continue;
    const price = Number(row.price_usd_per_mg);
    if (!Number.isFinite(price) || price <= 0) continue;
    const bucket = truncateToBucket(row.observed_at, aggregation);
    if (bucket === null) continue;
    let entry = bySupplier.get(row.supplier_id);
    if (!entry) {
      entry = {
        code: supplier.code,
        display_name: supplier.display_name,
        buckets: new Map(),
      };
      bySupplier.set(row.supplier_id, entry);
    }
    const acc = entry.buckets.get(bucket);
    if (acc) {
      acc.sum += price;
      acc.count += 1;
    } else {
      entry.buckets.set(bucket, { sum: price, count: 1 });
    }
  }

  const out: VendorSeries[] = [];
  for (const entry of bySupplier.values()) {
    const points: VendorPoint[] = [...entry.buckets.entries()]
      .map(([timestamp, acc]) => ({
        timestamp,
        price_usd_per_mg: round4(acc.sum / acc.count),
        observation_count: acc.count,
      }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    out.push({
      vendor_code: entry.code,
      vendor_display_name: entry.display_name,
      points,
    });
  }
  out.sort((a, b) => a.vendor_display_name.localeCompare(b.vendor_display_name));
  return out;
}

/**
 * Buckets TWAP commits by truncated computed_at and averages the
 * value per bucket. `cycle_count` is the number of finalised commits
 * inside that bucket.
 */
function aggregateTwapSeries(
  rows: TwapRow[],
  aggregation: "daily" | "hourly",
): TwapPoint[] {
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    const bucket = truncateToBucket(row.computed_at, aggregation);
    if (bucket === null) continue;
    const value = Number(row.twap_value);
    if (!Number.isFinite(value) || value <= 0) continue;
    const acc = buckets.get(bucket);
    if (acc) {
      acc.sum += value;
      acc.count += 1;
    } else {
      buckets.set(bucket, { sum: value, count: 1 });
    }
  }
  return [...buckets.entries()]
    .map(([timestamp, acc]) => ({
      timestamp,
      twap_value_usd_per_mg: round4(acc.sum / acc.count),
      cycle_count: acc.count,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Truncates an ISO-ish timestamp to the start of its UTC day or hour.
 * Returns null on parse failure so the caller can skip the row.
 *
 *   '2026-05-13T14:37:22Z'  daily  → '2026-05-13T00:00:00.000Z'
 *   '2026-05-13T14:37:22Z'  hourly → '2026-05-13T14:00:00.000Z'
 */
export function truncateToBucket(
  ts: string,
  aggregation: "daily" | "hourly",
): string | null {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (aggregation === "daily") {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    ).toISOString();
  }
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
    ),
  ).toISOString();
}

function extractSupplier(
  s: ObservationRow["suppliers"],
): { code: string; display_name: string } | null {
  if (!s) return null;
  if (Array.isArray(s)) {
    const first = s[0];
    return first ? { code: first.code, display_name: first.display_name } : null;
  }
  return { code: s.code, display_name: s.display_name };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/* ─── Test exports ─────────────────────────────────────────────── */

export const _internal = {
  CODE_RE,
  VENDOR_CODE_RE,
  truncateToBucket,
  aggregateVendorSeries,
  aggregateTwapSeries,
  round4,
};
