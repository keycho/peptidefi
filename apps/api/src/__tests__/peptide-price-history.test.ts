import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * Tests for GET /v1/peptides/:code/price-history.
 *
 * Pinned contracts:
 *   1. 400 on invalid :code shape or out-of-range params
 *   2. 404 when peptide doesn't exist
 *   3. 404 when ?vendor= references an unknown supplier code
 *   4. 200 + documented shape on BPC157 with default params
 *   5. ?days=30 accepted and reflected in window_start
 *   6. ?vendor=PUREHEALTH narrows the response to one series even
 *      across many vendor observations in the window
 *   7. Observation-phase peptide (no TWAPs in window) returns 200
 *      with an empty twap_series rather than 500
 *   8. Cache-Control: public, max-age=300 on every 200
 *
 * Uses the chainable supabase mock pattern established in
 * anomalies-stats.test.ts and research.test.ts.
 */

vi.mock("../supabase", () => {
  return {
    adminClientUntyped: () => ({
      from(table: string) {
        const builder: Record<string, unknown> = {
          select(_cols: string) { return builder; },
          eq(_col: string, _val: unknown) { return builder; },
          gte(_col: string, _val: unknown) { return builder; },
          lte(_col: string, _val: unknown) { return builder; },
          not(_col: string, _op: string, _val: unknown) { return builder; },
          order(_col: string, _opts: unknown) { return builder; },
          limit(_n: number) { return builder; },
          maybeSingle() {
            return Promise.resolve(globalThis.__priceHistoryResolver!(table));
          },
          then(onF: (v: { data: unknown; error: unknown }) => unknown) {
            return Promise.resolve(
              globalThis.__priceHistoryResolver!(table),
            ).then(onF);
          },
        };
        return builder;
      },
    }),
  };
});

declare global {
  // eslint-disable-next-line no-var
  var __priceHistoryResolver:
    | ((table: string) => { data: unknown; error: unknown })
    | undefined;
}

function setResolver(
  fn: (table: string) => { data: unknown; error: unknown },
): void {
  globalThis.__priceHistoryResolver = fn;
}

beforeEach(() => {
  globalThis.__priceHistoryResolver = undefined;
});
afterEach(() => {
  globalThis.__priceHistoryResolver = undefined;
});

function makeReq(code: string, query: Record<string, string> = {}): Request {
  return { params: { code }, query } as unknown as Request;
}

function makeRes(): {
  res: Response;
  status: () => number | undefined;
  body: () => Record<string, unknown> | undefined;
  headers: () => Record<string, string>;
} {
  let statusCode: number | undefined;
  let payload: Record<string, unknown> | undefined;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) { statusCode = code; return this; },
    set(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    json(b: Record<string, unknown>) { payload = b; return this; },
  } as unknown as Response;
  return {
    res,
    status: () => statusCode,
    body: () => payload,
    headers: () => headers,
  };
}

const PEPTIDE_BPC157 = {
  id: 2,
  code: "BPC157",
  display_name: "BPC-157",
};

// Build a synthetic observation 4 hours back from "now" — sits well
// inside the default 14-day window.
function obs({
  supplier_id,
  code,
  display,
  price,
  hoursAgo,
}: {
  supplier_id: number;
  code: string;
  display: string;
  price: string;
  hoursAgo: number;
}) {
  return {
    supplier_id,
    price_usd_per_mg: price,
    observed_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    suppliers: { code, display_name: display },
  };
}

function twap({ value, hoursAgo }: { value: string; hoursAgo: number }) {
  return {
    twap_value: value,
    computed_at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
  };
}

describe("price-history handler — input validation", () => {
  it("400 when :code violates the [A-Z0-9]{2,16} pattern", async () => {
    const { getPeptidePriceHistoryHandler } = await import(
      "../routes/v1/peptide-price-history"
    );
    setResolver(() => ({ data: null, error: null }));
    const { res, status, body } = makeRes();
    await getPeptidePriceHistoryHandler(makeReq("bp c"), res);
    expect(status()).toBe(400);
    expect((body() as { code: string }).code).toBe("BAD_REQUEST");
  });

  it("400 when days exceeds the max of 90", async () => {
    const { getPeptidePriceHistoryHandler } = await import(
      "../routes/v1/peptide-price-history"
    );
    setResolver(() => ({ data: null, error: null }));
    const { res, status } = makeRes();
    await getPeptidePriceHistoryHandler(
      makeReq("BPC157", { days: "365" }),
      res,
    );
    expect(status()).toBe(400);
  });
});

describe("price-history handler — 404 contracts", () => {
  it("404 when the peptide code is unknown", async () => {
    const { getPeptidePriceHistoryHandler } = await import(
      "../routes/v1/peptide-price-history"
    );
    setResolver((table) => {
      if (table === "peptides") return { data: null, error: null };
      return { data: null, error: null };
    });
    const { res, status, body } = makeRes();
    await getPeptidePriceHistoryHandler(makeReq("ZZZZ"), res);
    expect(status()).toBe(404);
    expect((body() as { message: string }).message).toContain("ZZZZ");
  });

  it("404 when ?vendor= names an unknown supplier code", async () => {
    const { getPeptidePriceHistoryHandler } = await import(
      "../routes/v1/peptide-price-history"
    );
    setResolver((table) => {
      if (table === "peptides") return { data: PEPTIDE_BPC157, error: null };
      if (table === "suppliers") return { data: null, error: null };
      return { data: null, error: null };
    });
    const { res, status, body } = makeRes();
    await getPeptidePriceHistoryHandler(
      makeReq("BPC157", { vendor: "DOESNOTEXIST" }),
      res,
    );
    expect(status()).toBe(404);
    expect((body() as { message: string }).message).toContain("DOESNOTEXIST");
  });
});

describe("price-history handler — happy path", () => {
  it("200 + documented shape for BPC157 with defaults", async () => {
    const { getPeptidePriceHistoryHandler } = await import(
      "../routes/v1/peptide-price-history"
    );
    setResolver((table) => {
      if (table === "peptides") return { data: PEPTIDE_BPC157, error: null };
      if (table === "supplier_observations")
        return {
          data: [
            obs({ supplier_id: 1, code: "PUREHEALTH", display: "Pure Health Peptides", price: "3.6", hoursAgo: 4 }),
            obs({ supplier_id: 1, code: "PUREHEALTH", display: "Pure Health Peptides", price: "3.7", hoursAgo: 5 }),
            obs({ supplier_id: 6, code: "GENETIC", display: "Genetic Peptide", price: "11.0", hoursAgo: 6 }),
          ],
          error: null,
        };
      if (table === "twap_commits")
        return {
          data: [
            twap({ value: "6.699", hoursAgo: 1 }),
            twap({ value: "6.700", hoursAgo: 24 }),
          ],
          error: null,
        };
      return { data: null, error: null };
    });
    const { res, body, headers } = makeRes();
    await getPeptidePriceHistoryHandler(makeReq("BPC157"), res);
    const b = body() as {
      peptide_code: string;
      peptide_display_name: string;
      window_start: string;
      window_end: string;
      aggregation: "daily" | "hourly";
      vendors: Array<{
        vendor_code: string;
        vendor_display_name: string;
        points: Array<{
          timestamp: string;
          price_usd_per_mg: number;
          observation_count: number;
        }>;
      }>;
      twap_series: Array<{
        timestamp: string;
        twap_value_usd_per_mg: number;
        cycle_count: number;
      }>;
    };
    expect(b.peptide_code).toBe("BPC157");
    expect(b.peptide_display_name).toBe("BPC-157");
    expect(b.aggregation).toBe("daily");
    expect(b.vendors).toHaveLength(2);
    // Sorted by display name asc.
    expect(b.vendors[0]!.vendor_display_name).toBe("Genetic Peptide");
    expect(b.vendors[1]!.vendor_display_name).toBe("Pure Health Peptides");
    // PUREHEALTH had two obs in the same day-bucket; their average
    // is the bucket's price, and observation_count is 2.
    const ph = b.vendors[1]!.points[0]!;
    expect(ph.observation_count).toBe(2);
    expect(ph.price_usd_per_mg).toBeCloseTo(3.65, 4);

    expect(b.twap_series.length).toBeGreaterThan(0);
    expect(headers()["cache-control"]).toBe("public, max-age=300, s-maxage=300");
  });

  it("?days=30 reflected in the window length", async () => {
    const { getPeptidePriceHistoryHandler } = await import(
      "../routes/v1/peptide-price-history"
    );
    setResolver((table) => {
      if (table === "peptides") return { data: PEPTIDE_BPC157, error: null };
      if (table === "supplier_observations") return { data: [], error: null };
      if (table === "twap_commits") return { data: [], error: null };
      return { data: null, error: null };
    });
    const { res, body } = makeRes();
    await getPeptidePriceHistoryHandler(
      makeReq("BPC157", { days: "30" }),
      res,
    );
    const b = body() as { window_start: string; window_end: string };
    const startMs = Date.parse(b.window_start);
    const endMs = Date.parse(b.window_end);
    // ± a few seconds tolerance; just confirm the gap is ~30d
    const gapDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
    expect(gapDays).toBeGreaterThan(29.95);
    expect(gapDays).toBeLessThan(30.05);
  });

  it("?vendor=PUREHEALTH narrows to one series", async () => {
    const { getPeptidePriceHistoryHandler } = await import(
      "../routes/v1/peptide-price-history"
    );
    setResolver((table) => {
      if (table === "peptides") return { data: PEPTIDE_BPC157, error: null };
      if (table === "suppliers")
        return {
          data: { id: 1, code: "PUREHEALTH", display_name: "Pure Health Peptides" },
          error: null,
        };
      if (table === "supplier_observations")
        return {
          data: [
            obs({ supplier_id: 1, code: "PUREHEALTH", display: "Pure Health Peptides", price: "3.65", hoursAgo: 3 }),
          ],
          error: null,
        };
      if (table === "twap_commits") return { data: [], error: null };
      return { data: null, error: null };
    });
    const { res, body } = makeRes();
    await getPeptidePriceHistoryHandler(
      makeReq("BPC157", { vendor: "PUREHEALTH" }),
      res,
    );
    const b = body() as {
      vendors: Array<{ vendor_code: string; points: unknown[] }>;
    };
    expect(b.vendors).toHaveLength(1);
    expect(b.vendors[0]!.vendor_code).toBe("PUREHEALTH");
    expect(b.vendors[0]!.points).toHaveLength(1);
  });

  it("observation-phase peptide (no TWAPs in window) returns 200 with empty twap_series", async () => {
    const { getPeptidePriceHistoryHandler } = await import(
      "../routes/v1/peptide-price-history"
    );
    setResolver((table) => {
      if (table === "peptides")
        return {
          data: { id: 99, code: "MT2", display_name: "Melanotan II" },
          error: null,
        };
      if (table === "supplier_observations") return { data: [], error: null };
      if (table === "twap_commits") return { data: [], error: null };
      return { data: null, error: null };
    });
    const { res, status, body } = makeRes();
    await getPeptidePriceHistoryHandler(makeReq("MT2"), res);
    expect(status()).toBeUndefined(); // 200 default
    const b = body() as {
      vendors: unknown[];
      twap_series: unknown[];
    };
    expect(b.vendors).toEqual([]);
    expect(b.twap_series).toEqual([]);
  });
});

describe("price-history handler — pure helpers", () => {
  it("truncateToBucket('daily') zeros hours, minutes, seconds", async () => {
    const { _internal } = await import("../routes/v1/peptide-price-history");
    const out = _internal.truncateToBucket(
      "2026-05-13T14:37:22.123Z",
      "daily",
    );
    expect(out).toBe("2026-05-13T00:00:00.000Z");
  });

  it("truncateToBucket('hourly') zeros minutes + seconds, keeps the hour", async () => {
    const { _internal } = await import("../routes/v1/peptide-price-history");
    const out = _internal.truncateToBucket(
      "2026-05-13T14:37:22.123Z",
      "hourly",
    );
    expect(out).toBe("2026-05-13T14:00:00.000Z");
  });

  it("aggregateVendorSeries averages per-bucket prices and sorts vendors by display name", async () => {
    const { _internal } = await import("../routes/v1/peptide-price-history");
    const baseTs = "2026-05-12T08:00:00.000Z";
    const sameDay = "2026-05-12T22:00:00.000Z";
    const out = _internal.aggregateVendorSeries(
      [
        {
          supplier_id: 1,
          price_usd_per_mg: "4.0",
          observed_at: baseTs,
          suppliers: { code: "Z", display_name: "Zenith" },
        },
        {
          supplier_id: 1,
          price_usd_per_mg: "6.0",
          observed_at: sameDay,
          suppliers: { code: "Z", display_name: "Zenith" },
        },
        {
          supplier_id: 2,
          price_usd_per_mg: "10.0",
          observed_at: baseTs,
          suppliers: { code: "A", display_name: "Alpha" },
        },
      ],
      "daily",
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.vendor_display_name).toBe("Alpha");
    expect(out[1]!.vendor_display_name).toBe("Zenith");
    expect(out[1]!.points).toHaveLength(1);
    expect(out[1]!.points[0]!.price_usd_per_mg).toBeCloseTo(5.0, 4);
    expect(out[1]!.points[0]!.observation_count).toBe(2);
  });
});
