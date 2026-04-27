import { createHash } from "node:crypto";
import {
  mapAvailability,
  parseMassToMg,
  type AvailabilityTier,
  type ScrapeResult,
} from "@peptidefi/shared";
import type { SupplierModule } from "./index";

/**
 * Cayman Chemical scraper — JSON API path, no headless browser.
 *
 * The www.caymanchem.com SPA is a React app with empty static HTML; the
 * product page calls a public JSON endpoint at /seawolf/open/product/* to
 * load variants (pack sizes with prices) and stock (per-size availability).
 * We hit those two endpoints directly — much faster and more reliable than
 * driving the SPA in a browser.
 *
 * Reference SKU strategy: Cayman lists multiple pack sizes per catalog
 * number (e.g. 500 µg / 1 mg / 5 mg). For TWAP comparison we commit to ONE
 * variant per cycle. Choice rule:
 *
 *   1. Filter variants to those whose name parses to a milligram quantity
 *      (drops "Bulk" / "Custom").
 *   2. Pick the SMALLEST in-stock variant (lowest mg).
 *   3. Fall back to the SMALLEST overall variant if nothing is in stock.
 *
 * Smallest is stable cycle-to-cycle (a 5 mg pack might flip in/out of stock
 * but the 500 µg or 1 mg lab-research pack is consistently listed), and
 * matches what a research lab buyer would see by default in the SPA.
 *
 * Currency: prices come back as USD ("amount" field) and EUR
 * ("amountEur"). We always report USD here — FX conversion stays for
 * EUR-quoted suppliers like Bachem.
 */

const SEAWOLF = "https://www.caymanchem.com/seawolf";
const FETCH_TIMEOUT_MS = 12_000;

const REQUEST_HEADERS = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "accept-language": "en-US,en;q=0.9",
};

interface CaymanVariant {
  catalogNum: string;
  name: string;
  configId: string;
  amount: number; // USD
  amountEur: number;
  suppressPricing: boolean;
}

interface CaymanStockEntry {
  itemId: string;
  size: string;
  availability: number; // 0 = out, 1 = in (observed)
}

interface CaymanResponse<T> {
  success: boolean;
  message: string;
  content: T;
}

async function fetchJson<T>(url: string): Promise<{
  json: T;
  status: number;
  rawText: string;
}> {
  const res = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
  }
  let json: T;
  try {
    json = JSON.parse(rawText) as T;
  } catch {
    throw new Error(
      `non-JSON response from ${url} (status ${res.status}, first 200 chars: ${rawText.slice(0, 200)})`,
    );
  }
  return { json, status: res.status, rawText };
}

/**
 * `availability: 1` is the only positive value we've observed. Treat any
 * other integer as out_of_stock and leave the raw value in raw_availability
 * for later refinement if Cayman exposes new states.
 */
function caymanAvailabilityTier(
  flag: number | undefined,
): AvailabilityTier {
  if (flag === 1) return "in_stock";
  if (flag === 0) return "out_of_stock";
  return "unknown";
}

export const cayman: SupplierModule = {
  needsBrowser: false,

  async scrape({ supplierSku }): Promise<ScrapeResult> {
    const variantsUrl = `${SEAWOLF}/open/product/variants?ids=${encodeURIComponent(supplierSku)}`;
    const stockUrl = `${SEAWOLF}/open/product/stock?ids=${encodeURIComponent(supplierSku)}`;

    let variantsResp: { json: CaymanResponse<CaymanVariant[]>; status: number; rawText: string };
    let stockResp: { json: CaymanResponse<CaymanStockEntry[]>; status: number; rawText: string };
    try {
      // Parallel — both endpoints are independent.
      [variantsResp, stockResp] = await Promise.all([
        fetchJson<CaymanResponse<CaymanVariant[]>>(variantsUrl),
        fetchJson<CaymanResponse<CaymanStockEntry[]>>(stockUrl),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failure(msg);
    }

    const httpStatus = variantsResp.status;

    if (!variantsResp.json.success) {
      return failure(
        `seawolf variants reported success=false: ${variantsResp.json.message || "(no message)"}`,
        httpStatus,
      );
    }

    // Drop variants whose name doesn't parse to mg (e.g. "Bulk", "Custom").
    const sizedVariants = variantsResp.json.content
      .filter((v) => !v.suppressPricing)
      .map((v) => ({ raw: v, mg: parseMassToMg(v.name) }))
      .filter((x): x is { raw: CaymanVariant; mg: string } => x.mg !== null);

    if (sizedVariants.length === 0) {
      return failure(
        `no priced sized variants returned for sku=${supplierSku} (raw=${JSON.stringify(variantsResp.json.content).slice(0, 300)})`,
        httpStatus,
      );
    }

    // Build size → availability lookup. Stock entries key on the variant's
    // `name` (which equals stock.size).
    const stockByName = new Map<string, CaymanStockEntry>();
    if (stockResp.json.success) {
      for (const entry of stockResp.json.content) {
        stockByName.set(entry.size, entry);
      }
    }

    // Sort ascending by parsed mg.
    sizedVariants.sort((a, b) => Number(a.mg) - Number(b.mg));

    const inStock = sizedVariants.find(
      (v) => stockByName.get(v.raw.name)?.availability === 1,
    );
    const chosen = inStock ?? sizedVariants[0]!;
    const stockEntry = stockByName.get(chosen.raw.name);

    const tier = caymanAvailabilityTier(stockEntry?.availability);

    // Surface a useful raw_availability string for the audit trail.
    const rawAvailability = stockEntry
      ? `size=${chosen.raw.name} availability=${stockEntry.availability}`
      : `size=${chosen.raw.name} availability=unknown`;

    // Re-run the heuristic mapper for lead_time_days only. tier comes from
    // the API directly (more reliable than regex on Cayman), but
    // mapAvailability still extracts lead time from any text it sees.
    const leadInfo = mapAvailability(rawAvailability);

    // Hash the joined raw payload for change detection.
    const hash = createHash("sha256")
      .update(variantsResp.rawText)
      .update("|")
      .update(stockResp.rawText)
      .digest("hex")
      .slice(0, 32);

    return {
      raw_price: chosen.raw.amount.toFixed(6),
      raw_currency: "USD",
      raw_availability: rawAvailability,
      availability_tier: tier,
      lead_time_days: leadInfo.leadTimeDays,
      mass_mg: chosen.mg,
      raw_html_hash: hash,
      http_status: httpStatus,
      scrape_success: true,
      scrape_error: null,
    };
  },
};

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
