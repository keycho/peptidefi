import {
  type AdminClient,
  type FxRates,
  createAdminClient,
  fetchFxRates,
  logAnomaly,
  scrapeResultSchema,
  type ScrapeResult,
} from "@peptide-oracle/shared";
import { chromium, type Browser } from "playwright";
import {
  closeRun,
  getPreviousSuccess,
  openRun,
  type ProductRow,
  recordAvailabilityChange,
  updateProductMass,
  writeObservation,
} from "./persist";
import { getModule } from "./suppliers";
import { getProxyCreditsUsed } from "./suppliers/woocommerce";

/**
 * Single scraper cycle. Open a run, fetch FX, scrape every active
 * supplier_product (sequentially per supplier, in parallel within a
 * supplier), persist observations + availability events, close the run.
 *
 * Failure isolation: a thrown error in one product never aborts the cycle.
 * The supplier module is invoked under try/catch and any throw is recorded
 * as a failed observation row (audit trail per spec).
 *
 * Returns the run id and aggregate counters so the caller (CLI loop or
 * --once mode) can log a tidy summary line.
 */

// ─── Anomaly-log: per-vendor offline tracking ──────────────────────
//
// Module-scoped so state persists across cycles within the same
// process. A vendor is "failed this cycle" iff EVERY product attempt
// for that vendor in this cycle failed. After
// `VENDOR_OFFLINE_THRESHOLD` consecutive failed cycles we file a
// vendor_offline anomaly and remember its id; on the next successful
// cycle we file a vendor_recovered anomaly with resolvedBy pointing
// at it. A Railway redeploy resets state, which is fine — the
// tracker re-learns within `THRESHOLD` cycles.
const VENDOR_OFFLINE_THRESHOLD = 3;

interface VendorOfflineState {
  /** Cycles in a row where the vendor had zero successful scrapes. */
  consecutiveFailedCycles: number;
  /** Anomalies row id for the vendor_offline event, set when threshold crosses. */
  offlineAnomalyId: number | null;
  /** Wall-clock of the last successful scrape for this vendor (for recovery context). */
  lastSuccessAt: string | null;
  /** Last error message recorded for the vendor (for offline context). */
  lastErrorMessage: string | null;
  /** Wall-clock of the cycle that first crossed the threshold. */
  offlineSinceMs: number | null;
}

const vendorOfflineState = new Map<string, VendorOfflineState>();

function getOrInitVendorState(supplierCode: string): VendorOfflineState {
  let s = vendorOfflineState.get(supplierCode);
  if (!s) {
    s = {
      consecutiveFailedCycles: 0,
      offlineAnomalyId: null,
      lastSuccessAt: null,
      lastErrorMessage: null,
      offlineSinceMs: null,
    };
    vendorOfflineState.set(supplierCode, s);
  }
  return s;
}

/** Test-only — clear cross-cycle vendor state between unit tests. */
export function _resetVendorOfflineStateForTests(): void {
  vendorOfflineState.clear();
}
export interface CycleSummary {
  runId: number;
  attempted: number;
  succeeded: number;
  failed: number;
  status: "completed" | "partial" | "failed";
  errorSummary: string | null;
  durationMs: number;
  /** True when SCRAPER_USE_PROXY=true and the API key is set. */
  proxyEnabled: boolean;
  /** Cumulative ScrapingAnt credits used since process startup. */
  proxyCreditsSession: number;
}

export async function runOnce(): Promise<CycleSummary> {
  const startedAt = Date.now();
  const supabase = createAdminClient();
  const errors: string[] = [];

  // FX once per cycle — supplier modules don't fetch their own rates.
  const fxRates = await fetchFxRates();
  if (!fxRates) {
    errors.push(
      "FX rate providers all failed; price_usd_per_mg will be null for non-USD prices this cycle",
    );
  }

  const runId = await openRun(supabase);

  let products: ProductRow[];
  try {
    products = await loadActiveProducts(supabase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await closeRun(supabase, runId, {
      products_attempted: 0,
      products_succeeded: 0,
      products_failed: 0,
      status: "failed",
      error_summary: `loadActiveProducts: ${msg}`,
    });
    const proxyEnabled =
      (process.env.SCRAPER_USE_PROXY ?? "").toLowerCase() === "true" &&
      !!process.env.SCRAPINGANT_API_KEY;
    return {
      runId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      status: "failed",
      errorSummary: msg,
      durationMs: Date.now() - startedAt,
      proxyEnabled,
      proxyCreditsSession: getProxyCreditsUsed(),
    };
  }

  // Group by supplier so we can share a Playwright browser per supplier and
  // process suppliers sequentially.
  const bySupplier = new Map<string, ProductRow[]>();
  for (const p of products) {
    const list = bySupplier.get(p.supplier_code) ?? [];
    list.push(p);
    bySupplier.set(p.supplier_code, list);
  }

  let succeeded = 0;
  let failed = 0;

  for (const [supplierCode, supplierProducts] of bySupplier) {
    const mod = getModule(supplierCode);
    let browser: Browser | undefined;
    let browserLaunchError: string | null = null;
    try {
      if (mod.needsBrowser) {
        browser = await chromium.launch({ headless: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${supplierCode}: browser launch failed: ${msg}`);
      browserLaunchError = msg;
      // Fall through — scrapeOne() will also fail per product and write rows.
    }

    const results = await Promise.all(
      supplierProducts.map((product) =>
        scrapeOne({
          supabase,
          runId,
          product,
          mod,
          browser,
          fxRates,
        }).catch((err): boolean => {
          // Should not happen — scrapeOne traps internally. Belt-and-braces.
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${supplierCode}/${product.supplier_sku}: ${msg}`);
          return false;
        }),
      ),
    );

    let supplierSucceeded = 0;
    let supplierFailed = 0;
    for (const ok of results) {
      if (ok) {
        succeeded++;
        supplierSucceeded++;
      } else {
        failed++;
        supplierFailed++;
      }
    }

    // Vendor-cycle outcome — feeds the offline/recovered tracker.
    // Sample error: prefer the browser-launch failure if any (it
    // explains the whole cohort); otherwise fall back to the first
    // captured per-product error string.
    void trackVendorCycleOutcome({
      supplierCode,
      succeededInCycle: supplierSucceeded,
      failedInCycle: supplierFailed,
      cycleStartedAtMs: startedAt,
      sampleErrorMessage:
        browserLaunchError ??
        errors.find((e) => e.startsWith(`${supplierCode}/`)) ??
        null,
    });

    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${supplierCode}: browser close failed: ${msg}`);
      }
    }
  }

  // 'completed' matches the spec §3.2.2 / oracle findUnanchoredCycle
  // status filter. (Earlier versions wrote 'success' here, which the
  // oracle's status IN ('completed','partial') gate silently rejected
  // — so a fully-successful cycle was never picked up for commit.
  // 'completed' is the canonical name throughout the spec; this now
  // matches.)
  const status: CycleSummary["status"] =
    failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial";

  const errorSummary = errors.length > 0 ? errors.join(" | ") : null;

  await closeRun(supabase, runId, {
    products_attempted: products.length,
    products_succeeded: succeeded,
    products_failed: failed,
    status,
    error_summary: errorSummary,
  });

  const proxyEnabled =
    (process.env.SCRAPER_USE_PROXY ?? "").toLowerCase() === "true" &&
    !!process.env.SCRAPINGANT_API_KEY;

  return {
    runId,
    attempted: products.length,
    succeeded,
    failed,
    status,
    errorSummary,
    durationMs: Date.now() - startedAt,
    proxyEnabled,
    proxyCreditsSession: getProxyCreditsUsed(),
  };
}

async function loadActiveProducts(supabase: AdminClient): Promise<ProductRow[]> {
  // Three-way active filter:
  //   - supplier_products.active            (this row is in the active set)
  //   - suppliers.status='active'           (the supplier itself is enabled)
  //   - peptides.is_active=true             (the peptide is in the live TWAP set)
  // Cayman is paused via suppliers.status; NAD is gated via peptides.is_active.
  const { data, error } = await supabase
    .from("supplier_products")
    .select(
      `id, supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg,
       suppliers!inner(code, status),
       peptides!inner(code, is_active)`,
    )
    .eq("active", true);

  if (error) throw new Error(error.message);

  const rows: ProductRow[] = [];
  for (const r of data ?? []) {
    if (r.suppliers.status !== "active") continue;
    if (!r.peptides.is_active) continue;
    if (
      r.supplier_sku.startsWith("TODO_") ||
      r.product_url.startsWith("TODO_")
    ) {
      // Defensive: 0009 replaced these, but if anyone seeds new TODO_ rows
      // we want to skip rather than fetch garbage URLs.
      continue;
    }
    rows.push({
      id: r.id,
      supplier_id: r.supplier_id,
      peptide_id: r.peptide_id,
      peptide_code: r.peptides.code,
      supplier_code: r.suppliers.code,
      supplier_sku: r.supplier_sku,
      product_url: r.product_url,
      product_name: r.product_name,
      // numeric → string at the load boundary (see persist.ts numToNumber).
      mass_per_unit_mg: String(r.mass_per_unit_mg),
    });
  }
  return rows;
}

interface ScrapeOneArgs {
  supabase: AdminClient;
  runId: number;
  product: ProductRow;
  mod: ReturnType<typeof getModule>;
  browser: Browser | undefined;
  fxRates: FxRates | null;
}

/**
 * Scrape a single product, persist the observation, and (on tier change)
 * record an availability_event. Returns true on successful scrape.
 *
 * Never throws — any error is captured into a failure observation row so
 * the rest of the cycle continues.
 */
async function scrapeOne(args: ScrapeOneArgs): Promise<boolean> {
  const { supabase, runId, product, mod, browser, fxRates } = args;
  const observedAt = new Date();
  const startedAtMs = Date.now();

  let result: ScrapeResult;
  try {
    const raw = await mod.scrape({
      productUrl: product.product_url,
      supplierSku: product.supplier_sku,
      productName: product.product_name,
      browser,
    });
    // Strict runtime validation — a buggy supplier module cannot poison the DB.
    result = scrapeResultSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      raw_price: null,
      raw_currency: null,
      raw_availability: null,
      availability_tier: "unknown",
      lead_time_days: null,
      mass_mg: null,
      raw_html_hash: null,
      http_status: null,
      scrape_success: false,
      scrape_error: msg.slice(0, 2000),
    };
  }

  // Persist the observation first so getPreviousSuccess can use its id as
  // the "before" cursor.
  const written = await writeObservation(supabase, {
    runId,
    product,
    result,
    fxRates,
    observedAt,
  });

  if (result.scrape_success) {
    if (result.mass_mg) {
      try {
        await updateProductMass(supabase, product, result.mass_mg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `updateProductMass failed for ${product.id} (${product.supplier_code}/${product.supplier_sku}): ${msg}`,
        );
      }
    }

    const previous = await getPreviousSuccess(
      supabase,
      product.id,
      written.id,
    );
    if (previous && previous.availability_tier !== result.availability_tier) {
      await recordAvailabilityChange(supabase, {
        product,
        previousObservationId: previous.id,
        currentObservationId: written.id,
        previousTier: previous.availability_tier,
        currentTier: result.availability_tier,
      });
    }
  } else {
    // ── Anomaly log: terminal-failure event ──────────────────────
    // The supplier module already exhausts its own retries (e.g.
    // woocommerce.fetchPageWithRetry has 3 attempts) before the
    // throw lands here, so this IS the terminal failure — single
    // event per (product, cycle), no per-attempt noise.
    //
    // Distinguish parser failures from network/timeout failures
    // by HTTP status: a 200 response that still flowed through
    // the failure branch means the parser couldn't extract a
    // price (selector returned nothing, regex didn't match,
    // dose normalisation failed). That's a separate event type
    // because the operational signal is different — a parser
    // failure usually means a vendor changed their HTML; a
    // network failure usually means the vendor is flaky.
    const eventType = classifyScrapeFailureForAnomaly(result);
    const baseContext = {
      observation_id: written.id,
      http_status: result.http_status,
      error_message: result.scrape_error ?? null,
      product_url: product.product_url,
      product_sku: product.supplier_sku,
      duration_ms: Date.now() - startedAtMs,
    };
    if (eventType === "parser_failure") {
      void logAnomaly({
        severity: "error",
        eventType: "parser_failure",
        description: `${product.supplier_code} returned 200 but parser couldn't extract a price for ${product.peptide_code}`,
        vendorId: product.supplier_code,
        peptideId: product.peptide_code,
        observationId: written.id,
        context: {
          ...baseContext,
          parser_module: product.supplier_code.toLowerCase(),
        },
      });
    } else if (eventType === "scrape_failed") {
      void logAnomaly({
        severity: "warn",
        eventType: "scrape_failed",
        description: `${product.supplier_code} scrape of ${product.peptide_code} failed after retries: ${(result.scrape_error ?? "unknown").slice(0, 200)}`,
        vendorId: product.supplier_code,
        peptideId: product.peptide_code,
        observationId: written.id,
        context: baseContext,
      });
    }
  }

  return result.scrape_success;
}

/**
 * Classify a failed scrape result for the anomaly log:
 *   - http_status === 200  → parser_failure (vendor served HTML, we
 *                            couldn't extract a price — selector
 *                            stale, regex broke, dose normalisation
 *                            blew up).
 *   - anything else        → scrape_failed (network timeout, 5xx,
 *                            captcha, retry-exhausted throw).
 *
 * Pure: extracted so the unit test can pin the dispatch table
 * without dragging in supplier modules.
 */
export function classifyScrapeFailureForAnomaly(
  result: Pick<ScrapeResult, "http_status" | "scrape_success">,
): "parser_failure" | "scrape_failed" | null {
  if (result.scrape_success) return null;
  return result.http_status === 200 ? "parser_failure" : "scrape_failed";
}

// ─── Anomaly log: per-vendor offline / recovered transitions ──────
//
// Called once per (vendor, cycle) AFTER all of the vendor's product
// scrapes have finished. Updates the module-scoped vendorOfflineState
// counter and fires `vendor_offline` on threshold crossing or
// `vendor_recovered` on the first success after offline.
//
// Exported for unit testing — production code paths only call it
// from inside runOnce().
export async function trackVendorCycleOutcome(args: {
  supplierCode: string;
  succeededInCycle: number;
  failedInCycle: number;
  cycleStartedAtMs: number;
  /** Sample error message for the offline event's context. */
  sampleErrorMessage: string | null;
}): Promise<void> {
  const state = getOrInitVendorState(args.supplierCode);
  const cycleHadAnySuccess = args.succeededInCycle > 0;

  if (cycleHadAnySuccess) {
    const wasOffline = state.offlineAnomalyId !== null;
    const offlineSinceMs = state.offlineSinceMs;
    const missedCycles = state.consecutiveFailedCycles;
    const offlineId = state.offlineAnomalyId;
    state.consecutiveFailedCycles = 0;
    state.lastSuccessAt = new Date().toISOString();

    if (wasOffline && offlineId !== null) {
      // First success after a vendor_offline event — fire the
      // recovery and clear the offline marker.
      const offlineDurationMs =
        offlineSinceMs !== null ? Date.now() - offlineSinceMs : 0;
      void logAnomaly({
        severity: "info",
        eventType: "vendor_recovered",
        description: `${args.supplierCode} recovered after ${missedCycles} consecutive failed cycles`,
        vendorId: args.supplierCode,
        context: {
          offline_duration_ms: offlineDurationMs,
          missed_cycles: missedCycles,
        },
        resolvedBy: offlineId,
      });
      state.offlineAnomalyId = null;
      state.offlineSinceMs = null;
    }
    return;
  }

  // No successes this cycle — the vendor failed all peptide scrapes.
  state.consecutiveFailedCycles += 1;
  if (args.sampleErrorMessage) {
    state.lastErrorMessage = args.sampleErrorMessage.slice(0, 500);
  }

  if (
    state.consecutiveFailedCycles === VENDOR_OFFLINE_THRESHOLD &&
    state.offlineAnomalyId === null
  ) {
    // Crossed the threshold for the first time. Fire once and
    // remember the id; further failed cycles stay silent until
    // recovery (no per-cycle re-warn spam).
    const filed = await logAnomaly({
      severity: "error",
      eventType: "vendor_offline",
      description: `${args.supplierCode} failed ${VENDOR_OFFLINE_THRESHOLD} consecutive cycles — vendor appears offline`,
      vendorId: args.supplierCode,
      context: {
        consecutive_failures: state.consecutiveFailedCycles,
        last_success_at: state.lastSuccessAt,
        last_error_message: state.lastErrorMessage,
      },
    });
    state.offlineAnomalyId = filed?.id ?? null;
    state.offlineSinceMs = Date.now();
  }
}
