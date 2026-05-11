import type { SupabaseClient } from "@supabase/supabase-js";
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

  // Snapshot/diff the TWAP-eligible vendor + peptide sets BEFORE the
  // per-peptide loop. Fires `vendor_promoted_to_twap` /
  // `peptide_promoted_to_twap` for any supplier or peptide whose
  // `enabled_in_twap` flipped false→true since the last cycle. First
  // cycle after a process start warms up the snapshot without firing
  // (avoids a flood of events on every Railway redeploy).
  await detectVendorPromotions(supabase);
  await detectPeptidePromotions(supabase);

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
  // Two-axis eligibility (mirror of the supplier-side filter in
  // loadLatestObservationsPerSupplier):
  //   - peptides.is_active = true       — peptide is in the live set
  //   - peptides.enabled_in_twap = true — peptide contributes to TWAP
  //                                        cohorts. New peptides land
  //                                        at false (migration 0038)
  //                                        for a 7-day observation
  //                                        window. Scrape-yes / twap-no.
  // The cast is for the same reason as the suppliers query — the new
  // column isn't in the @peptide-oracle/db generated types yet.
  const sb = supabase as unknown as SupabaseClient;
  const { data, error } = await sb
    .from("peptides")
    .select("id, code")
    .eq("is_active", true)
    .eq("enabled_in_twap", true)
    .order("id", { ascending: true });
  if (error) throw new Error(`loadActivePeptides: ${error.message}`);
  return (data ?? []) as PeptideRow[];
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
/**
 * Load the latest TWAP-eligible observation per (peptide, supplier).
 *
 * Two-axis eligibility:
 *   - suppliers.status = 'active'     — the vendor is being scraped
 *   - suppliers.enabled_in_twap = true — the vendor's price contributes
 *     to TWAP cohorts. New vendors land at enabled_in_twap=false (see
 *     migration 0036) so their data is collected for quality review
 *     without polluting the on-chain peg. Worker filters BOTH; the
 *     scraper only filters status. The flip from false → true is
 *     surfaced by `detectVendorPromotions` below.
 *
 * The filter runs in JS rather than as a PostgREST `.eq()` because
 * we still need the row's supplier metadata for the secondary
 * dedup-per-supplier pass.
 */
async function loadLatestObservationsPerSupplier(
  supabase: AdminClient,
  peptideId: number,
  oldestAllowed: Date,
): Promise<TwapInput[]> {
  // Cast to untyped client locally — `enabled_in_twap` lives in the
  // schema (migration 0036) but isn't in @peptide-oracle/db generated
  // types yet. Switch back to the typed client once db types are
  // regenerated post-migration.
  const sb = supabase as unknown as SupabaseClient;
  const { data, error } = await sb
    .from("supplier_observations")
    .select(
      "id, supplier_id, price_usd_per_mg, observed_at, suppliers!inner(status, enabled_in_twap)",
    )
    .eq("peptide_id", peptideId)
    .eq("scrape_success", true)
    .not("price_usd_per_mg", "is", null)
    .gte("observed_at", oldestAllowed.toISOString())
    .order("observed_at", { ascending: false });

  if (error) throw new Error(`loadLatestObservationsPerSupplier: ${error.message}`);

  const seen = new Set<number>();
  const out: TwapInput[] = [];
  for (const row of (data ?? []) as unknown as Array<{
    id: number;
    supplier_id: number;
    price_usd_per_mg: string | null;
    observed_at: string;
    suppliers: { status: string; enabled_in_twap: boolean | null };
  }>) {
    if (row.suppliers.status !== "active") continue;
    // enabled_in_twap defaults true (migration 0036), so existing
    // vendors continue working unchanged. Explicit !== true so a
    // null / undefined from a partially-applied schema treats as
    // "not eligible" — fail closed, not open.
    if (row.suppliers.enabled_in_twap !== true) continue;
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

// ─── Anomaly log: vendor_promoted_to_twap ──────────────────────────
//
// Fires when a supplier's enabled_in_twap flag transitions from false
// to true between worker cycles. The trigger is in-process snapshot
// diffing — not a DB-level trigger or admin endpoint — because the
// flip is most often manual (operator UPDATE after 7-day quality
// review) and we want the operations log to surface the transition
// regardless of how the flag changes.
//
// Semantics:
//   - First cycle after a process start: the cycle WARMS UP the
//     snapshot without firing for any of the initially-eligible
//     vendors. (Otherwise every Railway redeploy would dump 11+
//     spurious events.)
//   - Subsequent cycles: any supplier_id present now that wasn't
//     present last cycle fires `vendor_promoted_to_twap` once. The
//     same supplier won't re-fire on later cycles because the
//     snapshot now includes them.
//   - Demotion (true → false) is silent. The operator already knows;
//     it's the rare positive transition we want loud.
//
// State persists across worker cycles within the same process. A
// process restart re-warms — same idempotency.

interface PromotionState {
  warmedUp: boolean;
  /** supplier_id → code, for the most recent eligible-set snapshot. */
  eligible: Map<number, string>;
}

const promotionState: PromotionState = {
  warmedUp: false,
  eligible: new Map(),
};

/** Test-only — reset cross-cycle promotion state between unit tests. */
export function _resetPromotionStateForTests(): void {
  promotionState.warmedUp = false;
  promotionState.eligible.clear();
}

interface SupplierEligibilityRow {
  id: number;
  code: string;
}

/**
 * Snapshot the current `enabled_in_twap=true AND status='active'`
 * supplier set. Diff against the previous snapshot; fire one
 * `vendor_promoted_to_twap` per supplier that's newly eligible.
 *
 * Called once per worker cycle, before the per-peptide loop.
 * Best-effort: a DB error here logs and returns without firing —
 * the worker continues its TWAP cycle. The promotion event is
 * cosmetic; the actual TWAP filtering already happened in
 * loadLatestObservationsPerSupplier.
 */
export async function detectVendorPromotions(
  supabase: AdminClient | SupabaseClient,
): Promise<void> {
  // Cast through SupabaseClient — `enabled_in_twap` (migration 0036)
  // isn't in the generated @peptide-oracle/db types yet, so the
  // typed client's .eq() rejects the column name. Cast scoped to
  // this function only so the rest of the worker stays typed.
  const sb = supabase as unknown as SupabaseClient;
  const { data, error } = await sb
    .from("suppliers")
    .select("id, code")
    .eq("status", "active")
    .eq("enabled_in_twap", true);
  if (error) {
    console.warn(
      `[worker] detectVendorPromotions query failed (non-fatal): ${error.message}`,
    );
    return;
  }
  const rows = (data ?? []) as SupplierEligibilityRow[];
  const current = new Map<number, string>(rows.map((r) => [r.id, r.code]));

  if (promotionState.warmedUp) {
    for (const [id, code] of current) {
      if (!promotionState.eligible.has(id)) {
        void logAnomaly({
          severity: "info",
          eventType: "vendor_promoted_to_twap",
          description: `vendor ${code} (id=${id}) flipped enabled_in_twap → true; observations now contribute to TWAP cohorts`,
          vendorId: code,
          context: {
            supplier_id: id,
            supplier_code: code,
            promoted_at: new Date().toISOString(),
          },
        });
      }
    }
  }
  // Update snapshot regardless of whether we fired (warmup or
  // steady-state). Demotions are intentionally NOT logged — they're
  // operator-initiated and visible at the API layer; only positive
  // transitions are loud.
  promotionState.eligible = current;
  promotionState.warmedUp = true;
}

// ─── Anomaly log: peptide_promoted_to_twap ────────────────────────
//
// Mirror of detectVendorPromotions but for peptides.enabled_in_twap
// (migration 0038). New peptides land at enabled_in_twap=false for a
// 7-day observation window; the operator UPDATEs to true after
// quality review. This loop fires peptide_promoted_to_twap once per
// false→true flip, with the same warmup / dedup / silent-demotion
// semantics as the vendor side.

interface PeptideEligibilityRow {
  id: number;
  code: string;
}

const peptidePromotionState: PromotionState = {
  warmedUp: false,
  eligible: new Map(),
};

/** Test-only — reset cross-cycle peptide-promotion state. */
export function _resetPeptidePromotionStateForTests(): void {
  peptidePromotionState.warmedUp = false;
  peptidePromotionState.eligible.clear();
}

export async function detectPeptidePromotions(
  supabase: AdminClient | SupabaseClient,
): Promise<void> {
  const sb = supabase as unknown as SupabaseClient;
  const { data, error } = await sb
    .from("peptides")
    .select("id, code")
    .eq("is_active", true)
    .eq("enabled_in_twap", true);
  if (error) {
    console.warn(
      `[worker] detectPeptidePromotions query failed (non-fatal): ${error.message}`,
    );
    return;
  }
  const rows = (data ?? []) as PeptideEligibilityRow[];
  const current = new Map<number, string>(rows.map((r) => [r.id, r.code]));

  if (peptidePromotionState.warmedUp) {
    for (const [id, code] of current) {
      if (!peptidePromotionState.eligible.has(id)) {
        void logAnomaly({
          severity: "info",
          eventType: "peptide_promoted_to_twap",
          description: `peptide ${code} (id=${id}) flipped enabled_in_twap → true; observations now contribute to TWAP cohorts`,
          peptideId: code,
          context: {
            peptide_id: id,
            peptide_code: code,
            promoted_at: new Date().toISOString(),
          },
        });
      }
    }
  }
  peptidePromotionState.eligible = current;
  peptidePromotionState.warmedUp = true;
}
