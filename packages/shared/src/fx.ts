import { bn, toNumeric, type Numeric } from "./numeric";

/**
 * USD foreign-exchange rates with a multi-provider fallback chain.
 *
 * Strategy:
 *   1. open.er-api.com — keyless, daily updates, very stable
 *   2. exchangerate.host — keyless legacy endpoint (may require key now;
 *      kept as a safety net in case the primary is rate-limited)
 *   3. null — caller writes fx_rate_to_usd = null and logs the failure
 *      to scraper_runs.error_summary, per the agreed degraded-mode plan.
 *
 * Rates are stored as "multiply local currency by this to get USD"
 * (USD-per-LOCAL). So for CHF-denominated Bachem prices, we multiply the
 * raw_price by fx_rate_to_usd to land in dollars.
 *
 * Fetch is a one-shot per scraper run — the scraper calls fetchFxRates()
 * once at the top of run.ts and passes the FxRates object into every
 * supplier module. No in-process cache needed.
 */

export interface FxRates {
  /** ISO 4217 code → USD-per-LOCAL as Numeric. USD itself is "1.000000". */
  ratesToUsd: Record<string, Numeric>;
  source: "open.er-api.com" | "exchangerate.host";
  fetchedAt: string;
}

interface Provider {
  name: FxRates["source"];
  url: string;
  /** Pull a USD-base rate map from the provider's response. */
  parse: (json: unknown) => Record<string, number> | null;
}

const PROVIDERS: Provider[] = [
  {
    name: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/USD",
    parse(json) {
      const obj = json as { result?: string; rates?: Record<string, number> };
      if (obj?.result !== "success" || !obj.rates) return null;
      return obj.rates;
    },
  },
  {
    name: "exchangerate.host",
    url: "https://api.exchangerate.host/latest?base=USD",
    parse(json) {
      const obj = json as { success?: boolean; rates?: Record<string, number> };
      if (obj?.success === false || !obj?.rates) return null;
      return obj.rates;
    },
  },
];

/**
 * Provider responses look like { "EUR": 0.92, "CHF": 0.91, ... } meaning
 * 1 USD = 0.92 EUR. To convert a EUR-denominated price to USD we want
 * 1 / 0.92 = 1.087 USD per EUR. This helper does that inversion and
 * formats to numeric(20, 8) (the schema's fx_rate_to_usd scale).
 */
function invertToUsdPerLocal(
  ratesUsdBase: Record<string, number>,
): Record<string, Numeric> {
  const out: Record<string, Numeric> = { USD: "1.00000000" };
  for (const [code, rate] of Object.entries(ratesUsdBase)) {
    if (!Number.isFinite(rate) || rate <= 0) continue;
    out[code.toUpperCase()] = toNumeric(bn(1).div(rate), 8);
  }
  return out;
}

export async function fetchFxRates(opts?: {
  timeoutMs?: number;
}): Promise<FxRates | null> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  for (const provider of PROVIDERS) {
    try {
      const res = await fetch(provider.url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as unknown;
      const ratesUsdBase = provider.parse(json);
      if (!ratesUsdBase) continue;
      return {
        ratesToUsd: invertToUsdPerLocal(ratesUsdBase),
        source: provider.name,
        fetchedAt: new Date().toISOString(),
      };
    } catch {
      // try the next provider
    }
  }
  return null;
}

/**
 * Look up the USD-per-LOCAL rate for a currency. Returns null when:
 *   - rates is null (provider chain exhausted)
 *   - the currency is not present in the rate map (unsupported / typo)
 */
export function rateToUsd(
  rates: FxRates | null,
  currency: string | null | undefined,
): Numeric | null {
  if (!rates || !currency) return null;
  const code = currency.trim().toUpperCase();
  return rates.ratesToUsd[code] ?? null;
}
