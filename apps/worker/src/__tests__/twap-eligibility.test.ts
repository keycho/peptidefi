import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetPromotionStateForTests, detectVendorPromotions } from "../run";

/**
 * Two-axis TWAP eligibility:
 *
 *   1. The supplier-join filter in loadLatestObservationsPerSupplier
 *      excludes observations from `enabled_in_twap=false` rows. Pinned
 *      indirectly here — we test the canonical detector that owns the
 *      same notion of eligibility.
 *
 *   2. detectVendorPromotions snapshot-diffs the eligible set across
 *      cycles and fires `vendor_promoted_to_twap` exactly once per
 *      false→true transition. Warm-up cycle is silent.
 *
 * The shared anomaly logger is mocked so we can assert event shapes
 * without touching Supabase.
 */

vi.mock("@peptide-oracle/shared", async (importOriginal) => {
  const real = await importOriginal<object>();
  return {
    ...real,
    logAnomaly: (...args: unknown[]) => {
      globalThis.__logCalls.push(args);
      return Promise.resolve({ id: globalThis.__nextLogId++ });
    },
  };
});

declare global {
  // eslint-disable-next-line no-var
  var __logCalls: unknown[][];
  // eslint-disable-next-line no-var
  var __nextLogId: number;
}

interface FakeSupabaseRow {
  id: number;
  code: string;
}

/**
 * Minimal supabase stub that supports the chain
 *   from('suppliers').select(...).eq('status','active').eq('enabled_in_twap',true)
 * and resolves to a configurable list. Each test sets nextEligible to
 * control what the next detectVendorPromotions call sees.
 */
function makeFakeSupabase(): {
  client: Parameters<typeof detectVendorPromotions>[0];
  setNextEligible: (rows: FakeSupabaseRow[]) => void;
  setNextError: (msg: string) => void;
} {
  let nextEligible: FakeSupabaseRow[] = [];
  let nextError: string | null = null;
  const client = {
    from(_table: string) {
      const filters: Array<{ col: string; val: unknown }> = [];
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push({ col, val });
          return builder;
        },
        then(onF: (v: { data: unknown; error: unknown }) => unknown) {
          // Only resolve when both filters are present (mirrors the
          // production query shape). If a future code edit drops
          // either filter, this builder returns null data and the
          // test will fail loudly.
          const hasStatus = filters.some(
            (f) => f.col === "status" && f.val === "active",
          );
          const hasTwap = filters.some(
            (f) => f.col === "enabled_in_twap" && f.val === true,
          );
          if (!hasStatus || !hasTwap) {
            return Promise.resolve({
              data: null,
              error: { message: "test fake: missing required filter" },
            }).then(onF);
          }
          if (nextError) {
            return Promise.resolve({ data: null, error: { message: nextError } }).then(onF);
          }
          return Promise.resolve({ data: nextEligible, error: null }).then(onF);
        },
      };
      return builder;
    },
  } as unknown as Parameters<typeof detectVendorPromotions>[0];
  return {
    client,
    setNextEligible: (rows) => {
      nextEligible = rows;
      nextError = null;
    },
    setNextError: (msg) => {
      nextError = msg;
    },
  };
}

beforeEach(() => {
  _resetPromotionStateForTests();
  globalThis.__logCalls = [];
  globalThis.__nextLogId = 1;
});

afterEach(() => {
  _resetPromotionStateForTests();
});

describe("detectVendorPromotions — eligibility filter shape", () => {
  it("queries with both status=active AND enabled_in_twap=true", async () => {
    // The fake's then() asserts both filters are present; if either
    // is missing the resolved data is null + error is non-null. A
    // null return from detectVendorPromotions means "warmup" so the
    // first call always silent — but the eligible snapshot is empty
    // when filters are dropped, which would propagate to the second
    // call firing for every initially-eligible vendor wrongly. So
    // we test the TRANSITION assertion instead: with both filters
    // present, a flip from {} → {1: PANDA} fires exactly once.
    const fake = makeFakeSupabase();
    fake.setNextEligible([]);
    await detectVendorPromotions(fake.client);
    fake.setNextEligible([{ id: 1, code: "PANDA" }]);
    await detectVendorPromotions(fake.client);
    expect(globalThis.__logCalls).toHaveLength(1);
    const fired = globalThis.__logCalls[0]![0] as {
      eventType: string;
      vendorId: string;
    };
    expect(fired.eventType).toBe("vendor_promoted_to_twap");
    expect(fired.vendorId).toBe("PANDA");
  });
});

describe("detectVendorPromotions — warmup behaviour", () => {
  it("first cycle never fires — even for initially-eligible vendors", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([
      { id: 1, code: "PUREHEALTH" },
      { id: 2, code: "PURERAWZ" },
      { id: 3, code: "GENETIC" },
    ]);
    await detectVendorPromotions(fake.client);
    // Zero events — the warmup cycle just snapshots the set.
    expect(globalThis.__logCalls).toHaveLength(0);
  });

  it("steady-state cycle (same set as last) fires nothing", async () => {
    const fake = makeFakeSupabase();
    const eligible = [
      { id: 1, code: "PUREHEALTH" },
      { id: 2, code: "PURERAWZ" },
    ];
    fake.setNextEligible(eligible);
    await detectVendorPromotions(fake.client); // warmup
    fake.setNextEligible(eligible);
    await detectVendorPromotions(fake.client); // identical
    expect(globalThis.__logCalls).toHaveLength(0);
  });
});

describe("detectVendorPromotions — transition path (the actual code path operators exercise)", () => {
  it("REGRESSION: flipping a vendor from false→true fires exactly one event next cycle", async () => {
    const fake = makeFakeSupabase();
    // Cycle 1 (warmup): existing 8 vendors are eligible. PANDA was
    // just added at enabled_in_twap=false, so NOT in the snapshot.
    fake.setNextEligible([
      { id: 1, code: "PUREHEALTH" },
      { id: 2, code: "PURERAWZ" },
    ]);
    await detectVendorPromotions(fake.client);
    expect(globalThis.__logCalls).toHaveLength(0);

    // Cycle 2: operator UPDATEs PANDA's enabled_in_twap → true.
    fake.setNextEligible([
      { id: 1, code: "PUREHEALTH" },
      { id: 2, code: "PURERAWZ" },
      { id: 99, code: "PANDA" }, // newly promoted
    ]);
    await detectVendorPromotions(fake.client);

    expect(globalThis.__logCalls).toHaveLength(1);
    const call = globalThis.__logCalls[0]![0] as {
      severity: string;
      eventType: string;
      vendorId: string;
      context: { supplier_id: number; supplier_code: string };
    };
    expect(call.severity).toBe("info");
    expect(call.eventType).toBe("vendor_promoted_to_twap");
    expect(call.vendorId).toBe("PANDA");
    expect(call.context.supplier_id).toBe(99);
    expect(call.context.supplier_code).toBe("PANDA");
  });

  it("does NOT re-fire on subsequent cycles for the same supplier (idempotent)", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([{ id: 1, code: "PUREHEALTH" }]);
    await detectVendorPromotions(fake.client); // warmup
    fake.setNextEligible([
      { id: 1, code: "PUREHEALTH" },
      { id: 99, code: "PANDA" },
    ]);
    await detectVendorPromotions(fake.client); // fires once
    expect(globalThis.__logCalls).toHaveLength(1);

    // Same eligible set on cycle 3+; no re-fire.
    for (let i = 0; i < 3; i++) {
      fake.setNextEligible([
        { id: 1, code: "PUREHEALTH" },
        { id: 99, code: "PANDA" },
      ]);
      await detectVendorPromotions(fake.client);
    }
    expect(globalThis.__logCalls).toHaveLength(1);
  });

  it("fires per-vendor when multiple flips happen in the same cycle", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([{ id: 1, code: "PUREHEALTH" }]);
    await detectVendorPromotions(fake.client); // warmup
    // All 3 new vendors flipped in a single batch promote.
    fake.setNextEligible([
      { id: 1, code: "PUREHEALTH" },
      { id: 99, code: "PANDA" },
      { id: 100, code: "PURETESTED" },
      { id: 101, code: "PEPTIDELABS" },
    ]);
    await detectVendorPromotions(fake.client);
    expect(globalThis.__logCalls).toHaveLength(3);
    const codes = globalThis.__logCalls
      .map((c) => (c[0] as { vendorId: string }).vendorId)
      .sort();
    expect(codes).toEqual(["PANDA", "PEPTIDELABS", "PURETESTED"]);
  });

  it("demotion (true → false) is silent — no negative-transition event", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([
      { id: 1, code: "PUREHEALTH" },
      { id: 99, code: "PANDA" },
    ]);
    await detectVendorPromotions(fake.client); // warmup
    fake.setNextEligible([{ id: 1, code: "PUREHEALTH" }]); // PANDA demoted
    await detectVendorPromotions(fake.client);
    expect(globalThis.__logCalls).toHaveLength(0);
  });

  it("re-promotes after a demote/re-promote round-trip fires once on the second promotion", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([{ id: 1, code: "PUREHEALTH" }]);
    await detectVendorPromotions(fake.client); // warmup
    fake.setNextEligible([
      { id: 1, code: "PUREHEALTH" },
      { id: 99, code: "PANDA" },
    ]);
    await detectVendorPromotions(fake.client); // first promotion → fire
    expect(globalThis.__logCalls).toHaveLength(1);
    fake.setNextEligible([{ id: 1, code: "PUREHEALTH" }]); // demote
    await detectVendorPromotions(fake.client); // silent
    fake.setNextEligible([
      { id: 1, code: "PUREHEALTH" },
      { id: 99, code: "PANDA" },
    ]);
    await detectVendorPromotions(fake.client); // re-promote → fire again
    expect(globalThis.__logCalls).toHaveLength(2);
  });
});

describe("detectVendorPromotions — DB error is non-fatal", () => {
  it("logs warn and returns without firing on DB error", async () => {
    const fake = makeFakeSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.setNextError("permission denied for table suppliers");
    await detectVendorPromotions(fake.client);
    expect(globalThis.__logCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
