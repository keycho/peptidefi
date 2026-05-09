import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getProxyDiagnostics } from "../suppliers/woocommerce";

/**
 * Pin proxy-config parsing against the foot-guns we just hit in
 * production:
 *
 *   - Trailing newline / carriage return on the env value (Railway
 *     dashboard doesn't render whitespace; copy-paste from a doc
 *     can introduce \n).
 *   - Mixed case ("True" / "TRUE").
 *   - "1" as truthy (the spec'd shorthand).
 *   - Empty string vs unset.
 *   - Only one of the two vars set.
 *
 * Every test asserts BOTH the proxy_enabled bool AND the raw-value
 * fields exposed in the diagnostic snapshot — those are what the
 * proxy_state_at_startup anomaly event surfaces, so they're part of
 * the wire contract for ops debugging.
 */

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.SCRAPER_USE_PROXY;
  delete process.env.SCRAPINGANT_API_KEY;
});

afterEach(() => {
  process.env = originalEnv;
});

describe("getProxyDiagnostics — env-var parsing", () => {
  it("returns proxy_enabled=false with no env at all", () => {
    const d = getProxyDiagnostics();
    expect(d.proxy_enabled).toBe(false);
    expect(d.has_api_key).toBe(false);
    expect(d.raw_use_proxy_json).toBeNull();
    expect(d.api_key_fingerprint).toBeNull();
  });

  it("enables proxy with the canonical 'true' + key", () => {
    process.env.SCRAPER_USE_PROXY = "true";
    process.env.SCRAPINGANT_API_KEY = "abcdefgh1234567890";
    const d = getProxyDiagnostics();
    expect(d.proxy_enabled).toBe(true);
    expect(d.has_api_key).toBe(true);
    expect(d.raw_use_proxy_json).toBe('"true"');
    expect(d.raw_use_proxy_length).toBe(4);
    expect(d.api_key_fingerprint).toBe("18:abcd…7890");
  });

  it("accepts '1' shorthand", () => {
    process.env.SCRAPER_USE_PROXY = "1";
    process.env.SCRAPINGANT_API_KEY = "key";
    expect(getProxyDiagnostics().proxy_enabled).toBe(true);
  });

  it("accepts mixed case 'TRUE' / 'True'", () => {
    process.env.SCRAPINGANT_API_KEY = "key";
    process.env.SCRAPER_USE_PROXY = "TRUE";
    expect(getProxyDiagnostics().proxy_enabled).toBe(true);
    process.env.SCRAPER_USE_PROXY = "True";
    expect(getProxyDiagnostics().proxy_enabled).toBe(true);
  });

  it("REGRESSION: trailing whitespace doesn't disable the proxy", () => {
    // The smoking gun for the prod incident — Railway dashboard set
    // value showed as "true" but a hidden trailing \n made the
    // pre-fix `.toLowerCase() !== "true"` check fail.
    process.env.SCRAPINGANT_API_KEY = "key";
    for (const v of ["true\n", "true\r\n", " true", "true ", "  true  "]) {
      process.env.SCRAPER_USE_PROXY = v;
      const d = getProxyDiagnostics();
      expect(d.proxy_enabled, `expected proxy_enabled=true for ${JSON.stringify(v)}`)
        .toBe(true);
      // raw_use_proxy_json preserves the raw string so ops can SEE
      // what was really set (e.g. "true\n" surfaces as `"true\n"`).
      expect(d.raw_use_proxy_json).toBe(JSON.stringify(v));
    }
  });

  it("REGRESSION: trailing whitespace on api key trims correctly", () => {
    process.env.SCRAPER_USE_PROXY = "true";
    process.env.SCRAPINGANT_API_KEY = "abcdefgh\n";
    const d = getProxyDiagnostics();
    expect(d.proxy_enabled).toBe(true);
    expect(d.has_api_key).toBe(true);
    // length reports the RAW pre-trim length (9) so ops can see
    // there was a hidden char; fingerprint is computed on trimmed.
    expect(d.api_key_length).toBe(9);
    expect(d.api_key_fingerprint).toBe("8:abcd…efgh");
  });

  it("flag-on but no api key → proxy_enabled=false", () => {
    process.env.SCRAPER_USE_PROXY = "true";
    const d = getProxyDiagnostics();
    expect(d.proxy_enabled).toBe(false);
    expect(d.has_api_key).toBe(false);
  });

  it("api key present but flag off → proxy_enabled=false", () => {
    process.env.SCRAPINGANT_API_KEY = "key";
    process.env.SCRAPER_USE_PROXY = "false";
    const d = getProxyDiagnostics();
    expect(d.proxy_enabled).toBe(false);
    expect(d.has_api_key).toBe(true);
  });

  it("rejects empty / non-truthy values cleanly", () => {
    process.env.SCRAPINGANT_API_KEY = "key";
    for (const v of ["", "0", "no", "off", "yes", " "]) {
      process.env.SCRAPER_USE_PROXY = v;
      const d = getProxyDiagnostics();
      expect(d.proxy_enabled, `expected proxy_enabled=false for ${JSON.stringify(v)}`)
        .toBe(false);
    }
  });

  it("never leaks the full api key", () => {
    process.env.SCRAPER_USE_PROXY = "true";
    process.env.SCRAPINGANT_API_KEY = "ant_super_secret_key_value_xyz";
    const d = getProxyDiagnostics();
    const serialised = JSON.stringify(d);
    expect(serialised).not.toContain("ant_super_secret_key_value_xyz");
    expect(serialised).not.toContain("super_secret");
    // Fingerprint shape: length + first 4 + last 4 only.
    expect(d.api_key_fingerprint).toBe("30:ant_…_xyz");
  });
});
