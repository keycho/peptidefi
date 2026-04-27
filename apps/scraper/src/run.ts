import {
  type AdminClient,
  type FxRates,
  createAdminClient,
  fetchFxRates,
  scrapeResultSchema,
  type ScrapeResult,
} from "@peptidefi/shared";
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
export interface CycleSummary {
  runId: number;
  attempted: number;
  succeeded: number;
  failed: number;
  status: "success" | "partial" | "failed";
  errorSummary: string | null;
  durationMs: number;
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
    return {
      runId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      status: "failed",
      errorSummary: msg,
      durationMs: Date.now() - startedAt,
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
    try {
      if (mod.needsBrowser) {
        browser = await chromium.launch({ headless: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${supplierCode}: browser launch failed: ${msg}`);
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

    for (const ok of results) {
      if (ok) succeeded++;
      else failed++;
    }

    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${supplierCode}: browser close failed: ${msg}`);
      }
    }
  }

  const status: CycleSummary["status"] =
    failed === 0 ? "success" : succeeded === 0 ? "failed" : "partial";

  const errorSummary = errors.length > 0 ? errors.join(" | ") : null;

  await closeRun(supabase, runId, {
    products_attempted: products.length,
    products_succeeded: succeeded,
    products_failed: failed,
    status,
    error_summary: errorSummary,
  });

  return {
    runId,
    attempted: products.length,
    succeeded,
    failed,
    status,
    errorSummary,
    durationMs: Date.now() - startedAt,
  };
}

async function loadActiveProducts(supabase: AdminClient): Promise<ProductRow[]> {
  const { data, error } = await supabase
    .from("supplier_products")
    .select(
      `id, supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg,
       suppliers!inner(code)`,
    )
    .eq("active", true);

  if (error) throw new Error(error.message);

  const rows: ProductRow[] = [];
  for (const r of data ?? []) {
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
  }

  return result.scrape_success;
}
