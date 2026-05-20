import type { ScrapeResult } from "@peptide-oracle/shared";
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
 *   Tier 1 (live): eight WooCommerce vendors backed by the shared module.
 *     The factory wires per-vendor host config; the catalog fetch + parse
 *     code lives in woocommerce.ts and is identical across all of them.
 *
 *   Tier 2 (deferred): LIMITLESS (BigCommerce HTML scrape) and PARTICLE
 *     (PrestaShop HTML scrape). Both confirmed scrapable via cheerio
 *     during recon but need per-platform parsers; deferred until needed.
 *
 *   Paused: BACHEM and SIGMA (anti-bot blocks from datacenter IPs; need
 *     residential proxy or Cloudflare bypass). CAYMAN (different market
 *     tier — research-grade vs consumer; tracked separately as future
 *     reference price feature). MODERNAMINOS (Cloudflare anti-bot
 *     beats ScrapingAnt's standard tier — paused via supplier.status
 *     in the DB).
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
  // Added in migration 0019. SWISSCHEMS is reachable only via ScrapingAnt;
  // the WC module's existing retry loop (3s/8s) covers swisschems' upstream
  // flakiness during typical deploys.
  PURERAWZ:   createWooModule({ supplierCode: "PURERAWZ",   host: "purerawz.co" }),
  SWISSCHEMS: createWooModule({ supplierCode: "SWISSCHEMS", host: "swisschems.is" }),
  // Added in migration 0036. All three land at enabled_in_twap=false
  // — observations recorded, but excluded from TWAP cohorts pending
  // 7-day quality review. PEPTIDELABS is behind a Sucuri WAF that
  // blocks datacenter IPs (verified via sandbox curl: HTTP 202 +
  // sgcaptcha challenge); production needs SCRAPER_USE_PROXY=true.
  // PURETESTED's www subdomain is required — the host is set to
  // 'www.puretestedpeptides.com' literally (not a redirect chase).
  PANDA:       createWooModule({ supplierCode: "PANDA",       host: "pandapeptides.com" }),
  PURETESTED:  createWooModule({ supplierCode: "PURETESTED",  host: "www.puretestedpeptides.com" }),
  PEPTIDELABS: createWooModule({ supplierCode: "PEPTIDELABS", host: "peptidelabsinc.com" }),
  // Added in migration 0040. Both vanilla WC; reachable from datacenter
  // IPs (no proxy needed). EZPEP is pinned to ezpeptides.com — impostor
  // domains ezpeps.com / ezpeptidesofficial.com exist and must not be
  // confused with the canonical vendor. enabled_in_twap=false on both
  // pending the operator's quality-review window.
  EZPEP:      createWooModule({ supplierCode: "EZPEP",      host: "ezpeptides.com" }),
  OPTIPEP:    createWooModule({ supplierCode: "OPTIPEP",    host: "optimalpep.com" }),
  // Added in migration 0047 (vendor panel expansion batch 1). Vanilla
  // WC, reachable from datacenter IPs without Cloudflare, no account-
  // required gate observed during recon. enabled_in_twap=false pending
  // 7-day quality review. Two other batch-1 targets (Mile High
  // Compounds, Felix Chem) were deferred for account-gated UX matching
  // the ruo.bio criterion; see docs/follow-ups/vendor-expansion.md.
  PRIME:      createWooModule({ supplierCode: "PRIME",      host: "primepeptides.co" }),
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
