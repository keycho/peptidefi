import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetPeptidePromotionStateForTests,
  detectPeptidePromotions,
} from "../run";

/**
 * Mirror of twap-eligibility.test.ts but for the peptide side. The
 * detectPeptidePromotions snapshot/diff fires a
 * `peptide_promoted_to_twap` event exactly once per false→true
 * transition. Warm-up cycle is silent (otherwise every Railway
 * redeploy would dump events for every initially-eligible peptide).
 *
 * The user-facing flow these tests pin:
 *
 *   1. Migration 0038 inserts MT2/GHRP2/IGF1LR3 + flips TIRZEPATIDE+
 *      NAD to is_active=true, all at enabled_in_twap=false.
 *   2. Scraper collects observations during a 7-day window.
 *   3. Operator runs:
 *        UPDATE peptides SET enabled_in_twap=true WHERE code='MT2';
 *   4. Next worker cycle: detectPeptidePromotions notices the new
 *      row in the eligible set, fires peptide_promoted_to_twap once.
 *      MT2 observations now contribute to peptide_twaps from this
 *      cycle onwards.
 */

vi.mock("@peptide-oracle/shared", async (importOriginal) => {
  const real = await importOriginal<object>();
  return {
    ...real,
    logAnomaly: (...args: unknown[]) => {
      globalThis.__peptideLogCalls.push(args);
      return Promise.resolve({ id: globalThis.__peptideLogNextId++ });
    },
  };
});

declare global {
  // eslint-disable-next-line no-var
  var __peptideLogCalls: unknown[][];
  // eslint-disable-next-line no-var
  var __peptideLogNextId: number;
}

interface FakeRow {
  id: number;
  code: string;
}

function makeFakeSupabase(): {
  client: Parameters<typeof detectPeptidePromotions>[0];
  setNextEligible: (rows: FakeRow[]) => void;
  setNextError: (msg: string) => void;
} {
  let nextEligible: FakeRow[] = [];
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
          // Mirror the vendor test: assert both filters present so a
          // future edit that drops one of them fails loudly.
          const hasActive = filters.some(
            (f) => f.col === "is_active" && f.val === true,
          );
          const hasTwap = filters.some(
            (f) => f.col === "enabled_in_twap" && f.val === true,
          );
          if (!hasActive || !hasTwap) {
            return Promise.resolve({
              data: null,
              error: { message: "test fake: missing required filter" },
            }).then(onF);
          }
          if (nextError) {
            return Promise.resolve({
              data: null,
              error: { message: nextError },
            }).then(onF);
          }
          return Promise.resolve({ data: nextEligible, error: null }).then(onF);
        },
      };
      return builder;
    },
  } as unknown as Parameters<typeof detectPeptidePromotions>[0];
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
  _resetPeptidePromotionStateForTests();
  globalThis.__peptideLogCalls = [];
  globalThis.__peptideLogNextId = 1;
});

afterEach(() => {
  _resetPeptidePromotionStateForTests();
});

describe("detectPeptidePromotions — eligibility filter", () => {
  it("queries peptides with both is_active=true AND enabled_in_twap=true", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([]);
    await detectPeptidePromotions(fake.client);
    fake.setNextEligible([{ id: 50, code: "MT2" }]);
    await detectPeptidePromotions(fake.client);
    expect(globalThis.__peptideLogCalls).toHaveLength(1);
    const fired = globalThis.__peptideLogCalls[0]![0] as {
      eventType: string;
      peptideId: string;
    };
    expect(fired.eventType).toBe("peptide_promoted_to_twap");
    expect(fired.peptideId).toBe("MT2");
  });
});

describe("detectPeptidePromotions — warmup", () => {
  it("first cycle never fires for initially-eligible peptides", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([
      { id: 1, code: "BPC157" },
      { id: 2, code: "TB500" },
      { id: 3, code: "GHKCU" },
    ]);
    await detectPeptidePromotions(fake.client);
    expect(globalThis.__peptideLogCalls).toHaveLength(0);
  });

  it("steady-state cycle (same set as last) is silent", async () => {
    const fake = makeFakeSupabase();
    const eligible = [{ id: 1, code: "BPC157" }];
    fake.setNextEligible(eligible);
    await detectPeptidePromotions(fake.client);
    fake.setNextEligible(eligible);
    await detectPeptidePromotions(fake.client);
    expect(globalThis.__peptideLogCalls).toHaveLength(0);
  });
});

describe("detectPeptidePromotions — promotion (the migration-0038 review case)", () => {
  it("REGRESSION: flipping a peptide enabled_in_twap=true fires exactly one event", async () => {
    // Cycle 1 (warmup): existing peptides eligible. MT2 is NOT in
    // the snapshot — it was just added at enabled_in_twap=false.
    const fake = makeFakeSupabase();
    fake.setNextEligible([
      { id: 1, code: "BPC157" },
      { id: 2, code: "TB500" },
    ]);
    await detectPeptidePromotions(fake.client);
    expect(globalThis.__peptideLogCalls).toHaveLength(0);

    // Cycle 2: operator UPDATEs MT2 enabled_in_twap=true after the
    // 7-day quality review.
    fake.setNextEligible([
      { id: 1, code: "BPC157" },
      { id: 2, code: "TB500" },
      { id: 50, code: "MT2" },
    ]);
    await detectPeptidePromotions(fake.client);

    expect(globalThis.__peptideLogCalls).toHaveLength(1);
    const call = globalThis.__peptideLogCalls[0]![0] as {
      severity: string;
      eventType: string;
      peptideId: string;
      context: { peptide_id: number; peptide_code: string };
    };
    expect(call.severity).toBe("info");
    expect(call.eventType).toBe("peptide_promoted_to_twap");
    expect(call.peptideId).toBe("MT2");
    expect(call.context.peptide_id).toBe(50);
    expect(call.context.peptide_code).toBe("MT2");
  });

  it("does NOT re-fire on subsequent cycles for the same peptide", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([{ id: 1, code: "BPC157" }]);
    await detectPeptidePromotions(fake.client); // warmup
    fake.setNextEligible([
      { id: 1, code: "BPC157" },
      { id: 50, code: "MT2" },
    ]);
    await detectPeptidePromotions(fake.client); // fires once
    expect(globalThis.__peptideLogCalls).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      fake.setNextEligible([
        { id: 1, code: "BPC157" },
        { id: 50, code: "MT2" },
      ]);
      await detectPeptidePromotions(fake.client);
    }
    expect(globalThis.__peptideLogCalls).toHaveLength(1);
  });

  it("fires per-peptide when multiple flips happen in the same cycle", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([{ id: 1, code: "BPC157" }]);
    await detectPeptidePromotions(fake.client); // warmup
    // Operator promotes all 5 round-2 peptides in one batch UPDATE.
    fake.setNextEligible([
      { id: 1, code: "BPC157" },
      { id: 50, code: "MT2" },
      { id: 51, code: "GHRP2" },
      { id: 52, code: "IGF1LR3" },
      { id: 53, code: "TIRZEPATIDE" },
      { id: 54, code: "NAD" },
    ]);
    await detectPeptidePromotions(fake.client);
    expect(globalThis.__peptideLogCalls).toHaveLength(5);
    const codes = globalThis.__peptideLogCalls
      .map((c) => (c[0] as { peptideId: string }).peptideId)
      .sort();
    expect(codes).toEqual(["GHRP2", "IGF1LR3", "MT2", "NAD", "TIRZEPATIDE"]);
  });

  it("demotion (true → false) is silent", async () => {
    const fake = makeFakeSupabase();
    fake.setNextEligible([
      { id: 1, code: "BPC157" },
      { id: 50, code: "MT2" },
    ]);
    await detectPeptidePromotions(fake.client); // warmup
    fake.setNextEligible([{ id: 1, code: "BPC157" }]); // MT2 demoted
    await detectPeptidePromotions(fake.client);
    expect(globalThis.__peptideLogCalls).toHaveLength(0);
  });
});

describe("detectPeptidePromotions — DB error is non-fatal", () => {
  it("logs warn and returns without firing on DB error", async () => {
    const fake = makeFakeSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.setNextError("permission denied for table peptides");
    await detectPeptidePromotions(fake.client);
    expect(globalThis.__peptideLogCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
