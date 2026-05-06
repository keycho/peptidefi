import type { Request, Response } from "express";
import { adminClientUntyped } from "../../supabase";
import { clusterQuerySchema } from "../../validators";
import { sendError } from "../../errors";

/**
 * GET /v1/peptides/:code/vendor-prices
 *
 * Vendor-level price snapshot for one peptide: the most recent
 * successful observation per supplier in the last 24 hours, plus the
 * latest finalized TWAP commit for context, plus a min/max/spread
 * summary across the returned vendor prices.
 *
 *   :code      — peptide code, normalised to upper-case. Validated
 *                ^[A-Z0-9]{2,16}$.
 *   ?cluster=  — optional, applies ONLY to the TWAP block. Accepts
 *                'mainnet' | 'mainnet-beta' | 'devnet' | 'testnet'.
 *                Observations themselves are not cluster-tagged
 *                (they're scraper-side, never anchored on-chain).
 *
 * Query plan (3 round-trips, all small):
 *   1. peptides row by code → resolve to peptide_id (404 if absent).
 *   2. supplier_observations in last 24h, joined to suppliers via
 *      PostgREST embedded-select for the display_name. Reduced
 *      JS-side to one row per supplier_id (the first observed in
 *      desc order = the most recent).
 *   3. latest finalized twap_commits row for the peptide_code,
 *      optionally filtered by cluster.
 *
 * Response shape — see the schema in the project's API docs / the
 * /v1 conventions. Decimal values are returned as the raw
 * numeric(20,6) string from Postgres (e.g. "5.200000"); clients
 * format for display.
 *
 * Caching: Cache-Control: public, max-age=30, s-maxage=30. Scraper
 * cadence is 600s, so a 30s window adds at most 30s of staleness on
 * a freshly-cached response, which is irrelevant relative to the
 * underlying scrape interval. No server-side memoization — the two
 * Supabase queries are cheap and the small CDN/browser cache is
 * sufficient for current load.
 */

const SINCE_HOURS = 24;
const SINCE_MS = SINCE_HOURS * 60 * 60 * 1000;
const CODE_RE = /^[A-Z0-9]{2,16}$/;

interface ObservationRow {
  supplier_id: number | string;
  price_usd_per_mg: string | number;
  observed_at: string;
  // PostgREST returns embedded selects as either an object (for the
  // 1-to-1 case via FK) or an array (for the 1-to-many case). The
  // suppliers FK is many-to-1 from observations, so it comes back as
  // a single object. We accept both shapes defensively.
  suppliers: { display_name: string } | { display_name: string }[] | null;
}

interface TwapRow {
  twap_value: string | number;
  computed_at: string;
  cluster: string | null;
}

interface VendorEntry {
  vendor_name: string;
  price_usd_per_mg: string;
  observed_at: string;
}

interface SpreadBlock {
  min: string;
  max: string;
  variance_pct: number;
}

export async function getPeptideVendorPricesHandler(
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

  const parsedCluster = clusterQuerySchema.safeParse(req.query);
  if (!parsedCluster.success) {
    sendError(res, 400, "BAD_REQUEST", parsedCluster.error.message);
    return;
  }
  const { cluster } = parsedCluster.data;

  const supabase = adminClientUntyped();

  // 1. Resolve :code → peptide row.
  const { data: peptide, error: pErr } = await supabase
    .from("peptides")
    .select("id, code")
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

  // 2. Last 24h of priced, successful observations + supplier display
  // name. Ordered desc so the JS-side reduction picks the latest row
  // per supplier in one pass.
  const since = new Date(Date.now() - SINCE_MS).toISOString();
  const { data: obsRows, error: oErr } = await supabase
    .from("supplier_observations")
    .select(
      "supplier_id, price_usd_per_mg, observed_at, suppliers(display_name)",
    )
    .eq("peptide_id", peptide.id)
    .eq("scrape_success", true)
    .not("price_usd_per_mg", "is", null)
    .gte("observed_at", since)
    .order("observed_at", { ascending: false });
  if (oErr) {
    sendError(
      res,
      500,
      "DB_ERROR",
      `supplier_observations query failed: ${oErr.message}`,
    );
    return;
  }

  // 3. Latest finalized TWAP commit, optional cluster filter.
  let twapQ = supabase
    .from("twap_commits")
    .select("twap_value, computed_at, cluster")
    .eq("peptide_code", peptide.code)
    .eq("status", "finalized")
    .order("computed_at", { ascending: false })
    .limit(1);
  if (cluster !== undefined) twapQ = twapQ.eq("cluster", cluster);
  const { data: twapRows, error: tErr } = await twapQ;
  if (tErr) {
    sendError(res, 500, "DB_ERROR", `twap_commits query failed: ${tErr.message}`);
    return;
  }
  const twap: TwapRow | null = twapRows?.[0] ?? null;

  // ── Reduce: latest observation per supplier ──────────────────────
  // obsRows arrives ordered by observed_at desc. The Map insert-or-
  // skip pattern keeps the first (= newest) row per supplier_id.
  const latestPerSupplier = new Map<string | number, VendorEntry>();
  for (const row of (obsRows ?? []) as ObservationRow[]) {
    if (latestPerSupplier.has(row.supplier_id)) continue;
    const supplierName = extractSupplierName(row.suppliers);
    if (!supplierName) continue;
    latestPerSupplier.set(row.supplier_id, {
      vendor_name: supplierName,
      price_usd_per_mg: String(row.price_usd_per_mg),
      observed_at: row.observed_at,
    });
  }

  // Sort vendors by price ascending (per spec — better for the
  // spread visual the frontend will render).
  const vendors = [...latestPerSupplier.values()].sort(
    (a, b) => Number(a.price_usd_per_mg) - Number(b.price_usd_per_mg),
  );

  // ── Spread ──────────────────────────────────────────────────────
  const spread = computeSpread(vendors);

  // ── Cache + send ────────────────────────────────────────────────
  res.set("Cache-Control", "public, max-age=30, s-maxage=30");
  res.json({
    peptide_code: peptide.code,
    twap: twap
      ? {
          value_usd_per_mg: String(twap.twap_value),
          computed_at: twap.computed_at,
          cluster: normaliseCluster(twap.cluster),
        }
      : null,
    vendors,
    spread,
  });
}

/* ─── helpers ──────────────────────────────────────────────────── */

function extractSupplierName(
  s: ObservationRow["suppliers"],
): string | null {
  if (!s) return null;
  // PostgREST embedded selects can come back as object or array.
  if (Array.isArray(s)) return s[0]?.display_name ?? null;
  return s.display_name ?? null;
}

function computeSpread(vendors: VendorEntry[]): SpreadBlock | null {
  if (vendors.length === 0) return null;
  // Already sorted asc when this runs, but don't depend on it —
  // sort defensively in case the call site changes.
  const prices = vendors.map((v) => v.price_usd_per_mg);
  const numeric = prices.map((p) => Number(p));
  const minIdx = numeric.reduce((acc, v, i, arr) => (v < arr[acc]! ? i : acc), 0);
  const maxIdx = numeric.reduce((acc, v, i, arr) => (v > arr[acc]! ? i : acc), 0);
  const min = prices[minIdx]!;
  const max = prices[maxIdx]!;
  const minNum = numeric[minIdx]!;
  const maxNum = numeric[maxIdx]!;
  const variance_pct =
    minNum > 0 ? Number((((maxNum - minNum) / minNum) * 100).toFixed(1)) : 0;
  return { min, max, variance_pct };
}

function normaliseCluster(value: string | null): string | null {
  if (value === null) return null;
  if (value === "mainnet") return "mainnet-beta";
  return value;
}
