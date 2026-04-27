import { createHash } from "node:crypto";
import {
  parseMassToMg,
  type ScrapeResult,
  type AvailabilityTier,
} from "@peptidefi/shared";
import type { SupplierModule, ScrapeContext } from "./index";

/**
 * Shared WooCommerce Store API scraper module.
 *
 * One factory, six vendor instances. Each vendor's site exposes
 *   GET /wp-json/wc/store/v1/products?per_page=100
 * which returns its full product catalog as JSON. We:
 *
 *   1. Fetch the catalog ONCE per cycle (cached + inflight-deduped) so all
 *      14 peptide lookups for a given vendor share a single HTTP call.
 *   2. Look up each (vendor, peptide) pair by WooCommerce numeric id, which
 *      is stored in supplier_products.supplier_sku at seed time.
 *   3. Pick the smallest in-stock variant from the product's attribute
 *      terms (parsed to mg via shared/mass.ts), with the canonical
 *      fallback chain: variant attribute → mg parsed from product name.
 *   4. Convert the WC Store API minor-units price to a decimal string
 *      (see wcMinorToMajor below — this is the "destroy data if wrong" bit).
 *
 * Currency is read from prices.currency_code on every product so vendors
 * mixing USD and EUR (PULSE in particular) flow through the same shared
 * FX layer.
 */

interface WooConfig {
  /** Supplier code from public.suppliers.code, used in error messages. */
  supplierCode: string;
  /** Bare host: "purehealthpeptides.com" (no scheme, no trailing slash). */
  host: string;
}

interface WooProduct {
  id: number;
  name: string;
  slug: string;
  type: string;
  is_in_stock: boolean;
  is_purchasable?: boolean;
  prices: {
    price: string;
    price_range: { min_amount: string; max_amount: string } | null;
    currency_code: string;
    currency_minor_unit: number;
  };
  attributes?: Array<{ name?: string; terms?: Array<{ name: string }> }>;
  permalink?: string;
}

const FETCH_TIMEOUT_MS = 45_000;
const CATALOG_TTL_MS = 30_000; // one cycle; 60s loop refreshes naturally
const PER_PAGE = 100;
const MAX_PAGES = 10;

const REQUEST_HEADERS: Record<string, string> = {
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
};

const RATIO_RE = /\b(?:g|mg)\s*\/\s*(?:mol|mole|kg|L|liter|liters)\b/i;

/**
 * Read the WC-Store-API X-WP-TotalPages header from either the direct
 * response (`x-wp-totalpages`) or the ScrapingAnt-wrapped response
 * (`ant-original-header-x-wp-totalpages`). Defaults to 1.
 */
function readTotalPagesHeader(res: Response): number {
  const direct = res.headers.get("x-wp-totalpages");
  if (direct) {
    const n = Number.parseInt(direct, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const proxied = res.headers.get("ant-original-header-x-wp-totalpages");
  if (proxied) {
    const n = Number.parseInt(proxied, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

/**
 * ScrapingAnt proxy integration.
 *
 * When SCRAPER_USE_PROXY=true and SCRAPINGANT_API_KEY is set, every
 * catalog fetch is routed through ScrapingAnt's /v2/general endpoint so
 * vendor WAFs see ScrapingAnt's residential / datacenter pool instead of
 * our origin IP. This is what unblocks NUSCIENCE / GENETIC / VERIFIED /
 * PULSE from datacenter IP class.
 *
 * Pricing: 1 credit per fetch with browser=false (HTML/JSON passthrough,
 * no JS rendering — perfect for the WC Store API JSON endpoints we hit).
 * Free tier = 10,000 credits. Six vendors × one catalog fetch per cycle =
 * 6 credits/cycle. At a 60s cycle that's 360/hour — burns the free tier
 * in ~28 hours. Bump SCRAPER_CYCLE_INTERVAL_MS to 600000 (10 min) during
 * free-tier testing to stretch to ~7 days.
 *
 * Response shape (per ScrapingAnt v2 docs): the response body is the
 * target site's response body, passed through. Their HTTP status reflects
 * proxy success (200 even when target returned 503), so we still verify
 * the body parses as JSON before trusting it. Existing retry/error
 * paths therefore work unchanged.
 */
const SCRAPINGANT_BASE = "https://api.scrapingant.com/v2/general";

interface ProxyConfig {
  apiKey: string;
}

let proxyCreditsUsed = 0;

/** Number of proxy requests this process has issued. Reset only by restart. */
export function getProxyCreditsUsed(): number {
  return proxyCreditsUsed;
}

function readProxyConfig(): ProxyConfig | null {
  const flag = (process.env.SCRAPER_USE_PROXY ?? "false").toLowerCase();
  if (flag !== "true" && flag !== "1") return null;
  const apiKey = process.env.SCRAPINGANT_API_KEY;
  if (!apiKey) {
    // Only warn once per process. Cheap dedupe via a module-scoped flag.
    if (!warnedAboutMissingKey) {
      console.warn(
        "[woo] SCRAPER_USE_PROXY=true but SCRAPINGANT_API_KEY is not set; falling back to direct fetch",
      );
      warnedAboutMissingKey = true;
    }
    return null;
  }
  return { apiKey };
}
let warnedAboutMissingKey = false;

/**
 * Single fetch entry point — proxy-aware. timeoutMs is applied to the
 * outer request; ScrapingAnt typically adds 2-5s of latency vs direct.
 *
 * Headers passed to the target are mostly ignored by ScrapingAnt
 * (they set their own browser-like UA). We don't bother forwarding
 * REQUEST_HEADERS through the proxy.
 */
async function proxiedFetch(
  targetUrl: string,
  opts: { timeoutMs: number },
): Promise<Response> {
  const proxy = readProxyConfig();
  if (!proxy) {
    return fetch(targetUrl, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  }
  const params = new URLSearchParams({
    url: targetUrl,
    "x-api-key": proxy.apiKey,
    browser: "false",
    proxy_country: "US",
  });
  const res = await fetch(`${SCRAPINGANT_BASE}?${params.toString()}`, {
    headers: { accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  proxyCreditsUsed += 1;
  return res;
}

/**
 * Convert WooCommerce Store API minor-units → major-units decimal string.
 *
 *   ("10900", 2) → "109.00000000"     // $109.00
 *   ("84",    0) → "84.00000000"      // ¥84
 *   ("12345", 3) → "12.34500000"      // 12.345 of currency
 *
 * Returned scale is 8 to leave headroom for the schema's
 * supplier_observations.fx_rate_to_usd numeric(20, 8). Caller writes
 * raw_price into numeric(20, 6) which truncates safely.
 *
 * Why this matters: minor units are integer strings ("10900"). Treating
 * them as dollars would make every price 100× too large. This helper is
 * the single point of conversion across the module — change it once if
 * the convention ever flips.
 */
export function wcMinorToMajor(
  priceStr: string,
  minorUnit: number,
): string {
  if (!priceStr || !Number.isFinite(Number(priceStr))) return "0";
  // Plain integer divide via string ops to avoid Number-precision drift on
  // large values. Works for the integers Store API returns.
  if (minorUnit <= 0) return Number(priceStr).toFixed(8);
  const negative = priceStr.startsWith("-");
  const digits = (negative ? priceStr.slice(1) : priceStr).replace(/^0+/, "") || "0";
  const padded = digits.padStart(minorUnit + 1, "0");
  const intPart = padded.slice(0, padded.length - minorUnit) || "0";
  const fracPart = padded.slice(padded.length - minorUnit).padEnd(8, "0");
  return (negative ? "-" : "") + `${intPart}.${fracPart}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#8211;/g, "-")
    .replace(/&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#0?38;/g, "&");
}

function pickSmallestVariantMass(p: WooProduct): {
  term: string;
  mg: string;
} | null {
  // Pull all variant terms whose name parses to mg, skipping ratio strings
  // like "1419.5 g/mol" that the regex would otherwise match.
  const variants: { term: string; mg: number; mgString: string }[] = [];
  for (const attr of p.attributes ?? []) {
    for (const t of attr.terms ?? []) {
      const term = t.name ?? "";
      if (RATIO_RE.test(term)) continue;
      const mgStr = parseMassToMg(term);
      if (mgStr !== null) {
        variants.push({ term, mg: Number(mgStr), mgString: mgStr });
      }
    }
  }
  variants.sort((a, b) => a.mg - b.mg);
  const first = variants[0];
  if (first) {
    return { term: first.term, mg: first.mgString };
  }
  // Fallback to mass parsed from the product name, e.g. "BPC-157 (10MG)".
  const decoded = decodeEntities(p.name ?? "");
  if (RATIO_RE.test(decoded)) return null;
  const mgFromName = parseMassToMg(decoded);
  if (mgFromName !== null) {
    return { term: `(from name) ${decoded}`, mg: mgFromName };
  }
  return null;
}

function failure(message: string, httpStatus: number | null = null): ScrapeResult {
  return {
    raw_price: null,
    raw_currency: null,
    raw_availability: null,
    availability_tier: "unknown",
    lead_time_days: null,
    mass_mg: null,
    raw_html_hash: null,
    http_status: httpStatus,
    scrape_success: false,
    scrape_error: message.slice(0, 2000),
  };
}

function parseProduct(p: WooProduct, cfg: WooConfig): ScrapeResult {
  const smallest = pickSmallestVariantMass(p);
  if (!smallest) {
    return failure(
      `no parseable variant mass for ${cfg.supplierCode} id=${p.id} name="${p.name}"`,
      200,
    );
  }

  const minor = p.prices.currency_minor_unit ?? 2;
  const rawMinor = p.prices.price_range?.min_amount ?? p.prices.price;
  if (!rawMinor) {
    return failure(
      `no price returned for ${cfg.supplierCode} id=${p.id} name="${p.name}"`,
      200,
    );
  }
  const rawMajor = wcMinorToMajor(rawMinor, minor);

  const tier: AvailabilityTier = p.is_in_stock ? "in_stock" : "out_of_stock";

  // Stable per-product hash (id + price + stock + variant terms only — drops
  // the verbose description / image URLs that change with each WC edit).
  const hashable = JSON.stringify({
    id: p.id,
    price: rawMinor,
    minor,
    currency: p.prices.currency_code,
    in_stock: p.is_in_stock,
    variant: smallest.term,
  });
  const hash = createHash("sha256").update(hashable).digest("hex").slice(0, 32);

  return {
    raw_price: rawMajor,
    raw_currency: p.prices.currency_code,
    raw_availability: `is_in_stock=${p.is_in_stock} variant=${smallest.term}`,
    availability_tier: tier,
    lead_time_days: null,
    mass_mg: smallest.mg,
    raw_html_hash: hash,
    http_status: 200,
    scrape_success: true,
    scrape_error: null,
  };
}

class WooSupplierModule {
  readonly needsBrowser = false;
  private cache: { fetchedAt: number; byId: Map<number, WooProduct> } | null = null;
  private inflight: Promise<Map<number, WooProduct>> | null = null;

  constructor(private readonly cfg: WooConfig) {}

  scrape = async (ctx: ScrapeContext): Promise<ScrapeResult> => {
    const productId = Number.parseInt(ctx.supplierSku, 10);
    if (!Number.isFinite(productId)) {
      return failure(
        `invalid woocommerce supplier_sku (expected numeric id): "${ctx.supplierSku}"`,
      );
    }

    let catalog: Map<number, WooProduct>;
    try {
      catalog = await this.getCatalog();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failure(`${this.cfg.supplierCode} catalog fetch failed: ${msg}`);
    }

    const product = catalog.get(productId);
    if (!product) {
      return failure(
        `${this.cfg.supplierCode}: product id ${productId} not in catalog (${catalog.size} products fetched)`,
        200,
      );
    }

    return parseProduct(product, this.cfg);
  };

  private async getCatalog(): Promise<Map<number, WooProduct>> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CATALOG_TTL_MS) {
      return this.cache.byId;
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const byId = await this.fetchCatalog();
        this.cache = { fetchedAt: Date.now(), byId };
        return byId;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async fetchCatalog(): Promise<Map<number, WooProduct>> {
    const map = new Map<number, WooProduct>();
    let page = 1;
    while (page <= MAX_PAGES) {
      // NUSCIENCE returns 202 when ?page=1 is set explicitly but 200 when
      // omitted. We send the bare URL on the first request only.
      const url =
        page === 1
          ? `https://${this.cfg.host}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}`
          : `https://${this.cfg.host}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`;
      const { body, totalPages } = await this.fetchPageWithRetry(url);
      for (const p of body) {
        if (typeof p.id === "number") map.set(p.id, p);
      }
      if (body.length === 0 || page >= totalPages) break;
      page += 1;
    }
    return map;
  }

  /**
   * Catalog fetch with exponential-ish backoff retry.
   *
   * Vendor sites are intermittently flaky from datacenter IPs — observed
   * failure modes during the soak:
   *   - HTTP 503 from Cloudflare-fronted hosts during peak load.
   *   - HTTP 202 with HTML "captcha challenge" page from Sucuri-fronted hosts.
   *   - JSON.parse failure when the response is HTML masquerading as JSON.
   *
   * Each of these tends to clear within a few seconds. Two retries with
   * 3s / 8s sleeps catch the vast majority while keeping cycle time bounded.
   *
   * Proxy compatibility: when the request goes through ScrapingAnt, the
   * response Content-Type is "text/plain" (their wrapper) but the body is
   * still the target's JSON. We therefore do NOT gate on Content-Type —
   * instead we trust JSON.parse + Array.isArray to validate, which catches
   * both "vendor served HTML challenge" and "proxy returned text" cases
   * with a single check. Pagination header is dual-sourced because
   * ScrapingAnt rewrites X-WP-TotalPages → ant-original-header-x-wp-totalpages.
   */
  private async fetchPageWithRetry(
    url: string,
  ): Promise<{ body: WooProduct[]; totalPages: number }> {
    const delays = [0, 3000, 8000];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt]!;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await proxiedFetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} fetching ${url}`);
          continue;
        }
        const totalPages = readTotalPagesHeader(res);
        const text = await res.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          // Almost certainly a captcha / challenge HTML page — neither a direct
          // vendor 200-with-HTML nor a proxy passthrough of one.
          lastErr = new Error(
            `non-JSON body fetching ${url} (first 80 chars: ${text.slice(0, 80).replace(/\s+/g, " ")})`,
          );
          continue;
        }
        if (!Array.isArray(body)) {
          lastErr = new Error(
            `unexpected catalog response from ${this.cfg.host} (not an array; got ${typeof body})`,
          );
          continue;
        }
        return { body: body as WooProduct[], totalPages };
      } catch (err) {
        lastErr = err;
        continue;
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`exhausted retries: ${msg}`);
  }
}

/**
 * Factory. Each call returns a fresh module with its own catalog cache.
 */
export function createWooModule(cfg: WooConfig): SupplierModule {
  return new WooSupplierModule(cfg);
}
