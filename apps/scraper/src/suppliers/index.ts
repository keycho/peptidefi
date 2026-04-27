import type { ScrapeResult } from "@peptidefi/shared";
import type { Browser } from "playwright";
import { cayman } from "./cayman";
import { createWooModule } from "./woocommerce";

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
 * Active supplier modules.
 *
 *   Tier 1 (live): six WooCommerce vendors backed by the shared module.
 *     The factory wires per-vendor host config; the catalog fetch + parse
 *     code lives in woocommerce.ts and is identical across the six.
 *
 *   Tier 2 (deferred): LIMITLESS (BigCommerce HTML scrape) and PARTICLE
 *     (PrestaShop HTML scrape). Will land as a separate commit after the
 *     Tier-1 soak passes.
 *
 *   Paused: BACHEM and SIGMA (anti-bot blocks from datacenter IPs; need
 *     residential proxy or Cloudflare bypass). CAYMAN (different market
 *     tier — research-grade vs consumer; tracked separately as future
 *     reference price feature).
 *
 * Codes that don't match a registered module fall through to the
 * stubModule below, which writes a clean failure row so the audit trail
 * still records the attempt (per spec: every cycle writes a row per
 * supplier_product, success or fail).
 */
export const SUPPLIERS: Partial<Record<string, SupplierModule>> = {
  CAYMAN: cayman, // status='paused', so the runner won't dispatch to it; kept registered for clarity
  PUREHEALTH: createWooModule({ supplierCode: "PUREHEALTH", host: "purehealthpeptides.com" }),
  NUSCIENCE:  createWooModule({ supplierCode: "NUSCIENCE",  host: "nusciencepeptides.com" }),
  VERIFIED:   createWooModule({ supplierCode: "VERIFIED",   host: "verifiedpeptides.com" }),
  LIBERTY:    createWooModule({ supplierCode: "LIBERTY",    host: "libertypeptides.com" }),
  GENETIC:    createWooModule({ supplierCode: "GENETIC",    host: "geneticpeptide.com" }),
  PULSE:      createWooModule({ supplierCode: "PULSE",      host: "pulsepeptides.com" }),
};

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
