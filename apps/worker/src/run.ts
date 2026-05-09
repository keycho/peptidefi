import {
  type AdminClient,
  createAdminClient,
  logAnomaly,
  type Numeric,
} from "@peptide-oracle/shared";
import { computeTwap, type TwapInput } from "./twap";
import { insertPeptideTwap, logOutliers } from "./persist";

/**
 * Single TWAP cycle. For each is_active=true peptide:
 *   1. For each (peptide, supplier) pair where the supplier is active, take
 *      the SINGLE most-recent successful observation with a non-null price,
 *      regardless of when it occurred.
 *   2. Drop any observation older than WORKER_FRESHNESS_CEILING_MS
 *      (default 30 min) — that's the freshness ceiling. Beyond that point
 *      the data is too stale to publish; we'd rather honestly write
 *      twap_usd_per_mg=NULL than show last-week's prices.
 *   3. Hand the surviving observations to computeTwap() — it returns
 *      either a computed TWAP or a thin-data signal when fewer than 2
 *      suppliers reported fresh enough.
 *   4. Persist a peptide_twaps row regardless of the outcome — thin-data
 *      cases write twap_usd_per_mg=NULL as an honest audit signal.
 *
 * Why this design (Option B, decoupled from scrape cadence):
 *
 * The previous approach used a fixed 5-minute window. With the scraper
 * running on a 10-minute cadence (free-tier ScrapingAnt budget), most
 * worker cycles ran when no fresh observations existed in the 5-min
 * window — so the worker wrote a wave of NULL TWAPs after each scrape
 * cycle, and Lovable had to fall back to the last priced row.
 *
 * Decoupling: walk back per (peptide, supplier) to the latest observation
 * we have, capped by a freshness ceiling. This makes the worker robust to
 * any scraper cadence change and to short scraper outages — as long as
 * each supplier has SOMETHING within the freshness window, the TWAP gets
 * computed. The 30-minute default ceiling comfortably covers our 10-minute
 * cadence (~3× headroom for one missed scrape cycle) without showing
 * dangerously stale prices.
 *
 * Idempotency: computed_at is rounded to the start of the current UTC
 * minute, and peptide_twaps has unique (peptide_id, computed_at).
 * Re-running inside the same minute is a no-op via upsert
 * ignoreDuplicates.
 */

/** 30 minutes — three scrape cycles at the current 10-min cadence. */
const DEFAULT_FRESHNESS_CEILING_MS = 30 * 60 * 1000;

// ─── Anomaly log: vendor_disagreement detection ────────────────────
//
// Cross-vendor spread: (max - min) / median. When > 10% the cohort
// disagrees enough that the TWAP could swing materially based on
// which vendor reported. Worth surfacing.
//
// Suppression: a real disagreement (e.g. one vendor stuck at last
// week's price) can persist for hours. Logging every minute would
// drown the feed. Per-peptide state remembers the last fire time;
// suppressed cycles are silently counted and surfaced in the next
// fire's `cycles_with_disagreement` so the operator sees how long
// it's been ongoing.
const VENDOR_DISAGREEMENT_THRESHOLD = 0.10; // 10%
const VENDOR_DISAGREEMENT_SUPPRESS_MS = 60 * 60 * 1000; // 1 h

interface DisagreementState {
  lastFiredAtMs: number;
  /** Cycles that crossed the threshold while suppressed. Reset on fire. */
  suppressedCount: number;
  /** Anomaly id of the most-recent fire — informational only. */
  lastAnomalyId: number | null;
}

const peptideDisagreementState = new Map<number, DisagreementState>();

/** Test-only — clear cross-cycle disagreement state between unit tests. */
export function _resetDisagreementStateForTests(): void {
  peptideDisagreementState.clear();
}

export interface CycleSummary {
  peptidesProcessed: number;
  peptidesWithTwap: number;
  peptidesWithThinData: number;
  rowsInserted: number;
  rowsSkippedIdempotent: number;
  durationMs: number;
}

export async function runOnce(): Promise<CycleSummary> {
  const startedAt = Date.now();
  const supabase = createAdminClient();

  // Freshness ceiling: maximum age of an observation we'll consider. Beyond
  // this, the worker treats the supplier as silent. WORKER_TWAP_WINDOW_MS
  // is read for back-compat with .env files that already set it.
  const freshnessCeilingMs = Number.parseInt(
    process.env.WORKER_FRESHNESS_CEILING_MS ??
      process.env.WORKER_TWAP_WINDOW_MS ??
      String(DEFAULT_FRESHNESS_CEILING_MS),
    10,
  );

  // Round computed_at to start-of-current-minute UTC for idempotency.
  const now = new Date();
  const computedAt = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      0,
      0,
    ),
  );
  // window_end / window_start columns are kept for the audit trail. They
  // describe the freshness ceiling, not the original 5-min sliding window.
  const windowEnd = computedAt;
  const windowStart = new Date(computedAt.getTime() - freshnessCeilingMs);
  const oldestAllowed = windowStart;

  const peptides = await loadActivePeptides(supabase);

  let withTwap = 0;
  let withThinData = 0;
  let inserted = 0;
  let skipped = 0;

  for (const peptide of peptides) {
    const observations = await loadLatestObservationsPerSupplier(
      supabase,
      peptide.id,
      oldestAllowed,
    );

    const result = computeTwap(observations);

    let rowInserted: boolean;
    if (result.kind === "thin_data") {
      withThinData += 1;
      rowInserted = await insertPeptideTwap(supabase, {
        peptide_id: peptide.id,
        computed_at: computedAt,
        window_start: windowStart,
        window_end: windowEnd,
        twap_usd_per_mg: null,
        suppliers_used: result.kept.length,
        suppliers_dropped: 0,
        median_deviation_bps: null,
        input_observation_ids: result.kept.map((o) => o.observationId),
        dropped_observation_ids: [],
      });
    } else {
      withTwap += 1;
      rowInserted = await insertPeptideTwap(supabase, {
        peptide_id: peptide.id,
        computed_at: computedAt,
        window_start: windowStart,
        window_end: windowEnd,
        twap_usd_per_mg: result.twap,
        suppliers_used: result.kept.length,
        suppliers_dropped: result.dropped.length,
        median_deviation_bps: result.medianDeviationBps,
        input_observation_ids: result.kept.map((o) => o.observationId),
        dropped_observation_ids: result.dropped.map((o) => o.observationId),
      });

      if (result.dropped.length > 0) {
        await logOutliers(supabase, {
          peptide_id: peptide.id,
          detectedAt: computedAt,
          medianValue: result.twap,
          dropped: result.dropped,
        });
        // ── Anomaly log: dormant for v1 ──────────────────────────
        // computeTwap() always returns dropped=[] under the v1
        // straight-median algorithm, so this loop never runs today.
        // It's wired NOW so that when v2 turns on outlier filtering
        // (likely MAD-based per the twap.ts header comment), the
        // anomaly events fire automatically with no extra code
        // change. One event per excluded observation.
        for (const drop of result.dropped) {
          void logAnomaly({
            severity: "warn",
            eventType: "price_outlier_excluded",
            description: `${peptide.code}: dropped supplier ${drop.supplierId} price ${drop.priceUsdPerMg} from TWAP`,
            vendorId: String(drop.supplierId),
            peptideId: peptide.code,
            observationId: drop.observationId,
            context: {
              observed_price: drop.priceUsdPerMg,
              twap_median: result.twap,
              median_deviation_bps: result.medianDeviationBps,
              kept_supplier_count: result.kept.length,
            },
          });
        }
      }

      // ── Anomaly log: vendor_disagreement (cross-vendor spread) ─
      // Compute on the kept set (same data the median saw). >=2
      // suppliers are required for a meaningful spread; computeTwap
      // already gates that as `kind === 'computed'`.
      const detection = detectDisagreement(result.kept);
      if (detection.exceedsThreshold) {
        const state = peptideDisagreementState.get(peptide.id) ?? {
          lastFiredAtMs: 0,
          suppressedCount: 0,
          lastAnomalyId: null,
        };
        const now = Date.now();
        const sinceLastFireMs = now - state.lastFiredAtMs;
        if (sinceLastFireMs >= VENDOR_DISAGREEMENT_SUPPRESS_MS) {
          // Fire — initial detection or first re-fire after the 1h
          // suppression window expires.
          const filed = await logAnomaly({
            severity: "warn",
            eventType: "vendor_disagreement",
            description: `${peptide.code}: vendor spread ${(detection.spreadPct * 100).toFixed(1)}% exceeds ${(VENDOR_DISAGREEMENT_THRESHOLD * 100).toFixed(0)}% threshold`,
            peptideId: peptide.code,
            context: {
              vendor_prices: detection.vendorPrices,
              min_price: detection.minPrice,
              max_price: detection.maxPrice,
              median_price: result.twap,
              spread_pct: detection.spreadPct,
              cycles_with_disagreement: state.suppressedCount + 1,
            },
          });
          peptideDisagreementState.set(peptide.id, {
            lastFiredAtMs: now,
            suppressedCount: 0,
            lastAnomalyId: filed?.id ?? null,
          });
        } else {
          // Within the suppression window — count silently so the
          // next fire surfaces "this has been ongoing for N cycles".
          peptideDisagreementState.set(peptide.id, {
            ...state,
            suppressedCount: state.suppressedCount + 1,
          });
        }
      }
    }

    if (rowInserted) inserted += 1;
    else skipped += 1;
  }

  return {
    peptidesProcessed: peptides.length,
    peptidesWithTwap: withTwap,
    peptidesWithThinData: withThinData,
    rowsInserted: inserted,
    rowsSkippedIdempotent: skipped,
    durationMs: Date.now() - startedAt,
  };
}

interface PeptideRow {
  id: number;
  code: string;
}

interface DisagreementDetection {
  exceedsThreshold: boolean;
  spreadPct: number;
  minPrice: string;
  maxPrice: string;
  /** supplierId → priceUsdPerMg (string). */
  vendorPrices: Record<string, string>;
}

/**
 * Pure: compute (max-min)/median spread across the kept observations
 * and decide whether it crosses VENDOR_DISAGREEMENT_THRESHOLD.
 * Reference is the median of the same set, computed locally as a
 * BigNumber-free midpoint to avoid pulling another dependency in
 * here. With ≤ 8 active vendors this is cheap.
 */
function detectDisagreement(kept: TwapInput[]): DisagreementDetection {
  if (kept.length < 2) {
    return {
      exceedsThreshold: false,
      spreadPct: 0,
      minPrice: "0",
      maxPrice: "0",
      vendorPrices: {},
    };
  }
  const numericPrices = kept.map((o) => Number(o.priceUsdPerMg));
  const min = Math.min(...numericPrices);
  const max = Math.max(...numericPrices);
  const sorted = [...numericPrices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  const spreadPct = median > 0 ? (max - min) / median : 0;
  const vendorPrices: Record<string, string> = {};
  for (const o of kept) {
    vendorPrices[String(o.supplierId)] = String(o.priceUsdPerMg);
  }
  return {
    exceedsThreshold: spreadPct > VENDOR_DISAGREEMENT_THRESHOLD,
    spreadPct,
    minPrice: String(min),
    maxPrice: String(max),
    vendorPrices,
  };
}

/** Test-only — exposed so unit tests can pin the spread math. */
export const _internal = { detectDisagreement, VENDOR_DISAGREEMENT_THRESHOLD };

async function loadActivePeptides(supabase: AdminClient): Promise<PeptideRow[]> {
  const { data, error } = await supabase
    .from("peptides")
    .select("id, code")
    .eq("is_active", true)
    .order("id", { ascending: true });
  if (error) throw new Error(`loadActivePeptides: ${error.message}`);
  return data ?? [];
}

/**
 * For one peptide, return at most one TwapInput per supplier — the most
 * recent successful observation with a non-null price, capped at the
 * freshness ceiling.
 *
 * No upper-bound filter: we accept "now-ish" data even if it landed after
 * the rounded computed_at minute. We pull all candidate rows ordered by
 * observed_at DESC (single query) and keep the first per supplier
 * client-side — equivalent to SQL `DISTINCT ON (supplier_id) ORDER BY
 * observed_at DESC` but expressible in PostgREST without an RPC. With ~6
 * active suppliers × ~30 minutes of obs = ~30 rows per query worst-case,
 * this stays cheap.
 */
async function loadLatestObservationsPerSupplier(
  supabase: AdminClient,
  peptideId: number,
  oldestAllowed: Date,
): Promise<TwapInput[]> {
  const { data, error } = await supabase
    .from("supplier_observations")
    .select("id, supplier_id, price_usd_per_mg, observed_at, suppliers!inner(status)")
    .eq("peptide_id", peptideId)
    .eq("scrape_success", true)
    .not("price_usd_per_mg", "is", null)
    .gte("observed_at", oldestAllowed.toISOString())
    .order("observed_at", { ascending: false });

  if (error) throw new Error(`loadLatestObservationsPerSupplier: ${error.message}`);

  const seen = new Set<number>();
  const out: TwapInput[] = [];
  for (const row of data ?? []) {
    if (row.suppliers.status !== "active") continue;
    if (seen.has(row.supplier_id)) continue;
    seen.add(row.supplier_id);
    if (row.price_usd_per_mg === null) continue;
    out.push({
      observationId: row.id,
      supplierId: row.supplier_id,
      // numeric → string at the load boundary
      priceUsdPerMg: String(row.price_usd_per_mg) as Numeric,
    });
  }
  return out;
}
