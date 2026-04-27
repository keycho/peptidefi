import type { ScrapeResult } from "@peptidefi/shared";
import type { Browser } from "playwright";

/**
 * Per-supplier scraper module contract.
 *
 * scrape() is "pure" — fetch the product page, parse it, return a
 * ScrapeResult. It does NOT call Supabase, compute USD/mg, write the run
 * row, or diff availability. That's the runner's job (apps/scraper/src/run.ts).
 *
 * needsBrowser tells the runner whether to launch a Playwright browser for
 * this supplier. The browser instance is shared across the supplier's
 * products (parallel within the supplier) and torn down when the supplier
 * cycle finishes.
 */
export interface ScrapeContext {
  productUrl: string;
  supplierSku: string;
  productName: string;
  /** Populated by the runner when SupplierModule.needsBrowser === true. */
  browser?: Browser;
}

export interface SupplierModule {
  needsBrowser: boolean;
  scrape: (ctx: ScrapeContext) => Promise<ScrapeResult>;
}

/**
 * Real per-supplier modules land in Step 3 of the build — one at a time
 * (Cayman → Sigma → Bachem). Until then, every code falls through to the
 * not-implemented stub below, which writes a clean failure row to
 * supplier_observations so the rest of the pipeline (run rows, FX fetch,
 * persist path) is exercised end-to-end from day one.
 */
export const SUPPLIERS: Partial<Record<string, SupplierModule>> = {};

const stubModule: SupplierModule = {
  needsBrowser: false,
  async scrape({ supplierSku }) {
    return {
      raw_price: null,
      raw_currency: null,
      raw_availability: null,
      availability_tier: "unknown",
      lead_time_days: null,
      mass_mg: null,
      raw_html_hash: null,
      http_status: null,
      scrape_success: false,
      scrape_error: `supplier module not implemented (sku=${supplierSku})`,
    };
  },
};

export function getModule(supplierCode: string): SupplierModule {
  return SUPPLIERS[supplierCode] ?? stubModule;
}
