import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scraper-side anomaly events:
 *
 *   1. classifyScrapeFailureForAnomaly — pure dispatch table
 *      for parser_failure (200 + failed) vs scrape_failed (network /
 *      timeout / 5xx / retry-exhausted throw).
 *
 *   2. trackVendorCycleOutcome — per-vendor consecutive-failure
 *      counter that fires `vendor_offline` once on threshold (3
 *      cycles) and `vendor_recovered` (with resolvedBy) on the next
 *      success.
 *
 * The shared anomaly-log module is mocked so we can assert the call
 * shapes without hitting Supabase.
 */

vi.mock("@peptide-oracle/shared", async (importOriginal) => {
  const real = await importOriginal<object>();
  return {
    ...real,
    logAnomaly: (...args: unknown[]) => globalThis.__logResolver!(...args),
  };
});

declare global {
  // eslint-disable-next-line no-var
  var __logResolver:
    | ((...args: unknown[]) => Promise<{ id: number } | null>)
    | undefined;
  // eslint-disable-next-line no-var
  var __logCalls: unknown[][];
}

beforeEach(async () => {
  globalThis.__logCalls = [];
  let nextId = 1000;
  globalThis.__logResolver = async (...args: unknown[]) => {
    globalThis.__logCalls.push(args);
    return { id: nextId++ };
  };
  const mod = await import("../run");
  mod._resetVendorOfflineStateForTests();
});

afterEach(async () => {
  globalThis.__logResolver = undefined;
  const mod = await import("../run");
  mod._resetVendorOfflineStateForTests();
});

describe("classifyScrapeFailureForAnomaly", () => {
  it("returns null for successful scrapes", async () => {
    const { classifyScrapeFailureForAnomaly } = await import("../run");
    expect(
      classifyScrapeFailureForAnomaly({ scrape_success: true, http_status: 200 }),
    ).toBeNull();
    expect(
      classifyScrapeFailureForAnomaly({ scrape_success: true, http_status: null }),
    ).toBeNull();
  });

  it("classifies http=200 + failed as parser_failure", async () => {
    const { classifyScrapeFailureForAnomaly } = await import("../run");
    expect(
      classifyScrapeFailureForAnomaly({ scrape_success: false, http_status: 200 }),
    ).toBe("parser_failure");
  });

  it("classifies non-200 / null as scrape_failed", async () => {
    const { classifyScrapeFailureForAnomaly } = await import("../run");
    for (const status of [null, 0, 404, 500, 503, 429]) {
      expect(
        classifyScrapeFailureForAnomaly({
          scrape_success: false,
          http_status: status,
        }),
      ).toBe("scrape_failed");
    }
  });
});

describe("trackVendorCycleOutcome — vendor_offline / vendor_recovered", () => {
  it("does not fire below the threshold (1 then 2 failed cycles)", async () => {
    const { trackVendorCycleOutcome } = await import("../run");
    await trackVendorCycleOutcome({
      supplierCode: "VENDOR_X",
      succeededInCycle: 0,
      failedInCycle: 4,
      cycleStartedAtMs: Date.now(),
      sampleErrorMessage: "boom",
    });
    await trackVendorCycleOutcome({
      supplierCode: "VENDOR_X",
      succeededInCycle: 0,
      failedInCycle: 4,
      cycleStartedAtMs: Date.now(),
      sampleErrorMessage: "boom",
    });
    expect(globalThis.__logCalls).toHaveLength(0);
  });

  it("fires vendor_offline ONCE on the third consecutive failed cycle", async () => {
    const { trackVendorCycleOutcome } = await import("../run");
    for (let i = 0; i < 3; i++) {
      await trackVendorCycleOutcome({
        supplierCode: "VENDOR_X",
        succeededInCycle: 0,
        failedInCycle: 4,
        cycleStartedAtMs: Date.now(),
        sampleErrorMessage: `boom-${i}`,
      });
    }
    expect(globalThis.__logCalls).toHaveLength(1);
    const call = globalThis.__logCalls[0]![0] as {
      severity: string;
      eventType: string;
      vendorId: string;
      context: { consecutive_failures: number; last_error_message: string };
    };
    expect(call.severity).toBe("error");
    expect(call.eventType).toBe("vendor_offline");
    expect(call.vendorId).toBe("VENDOR_X");
    expect(call.context.consecutive_failures).toBe(3);
    expect(call.context.last_error_message).toBe("boom-2");
  });

  it("does NOT re-fire vendor_offline on subsequent failed cycles (dedup until recovery)", async () => {
    const { trackVendorCycleOutcome } = await import("../run");
    for (let i = 0; i < 6; i++) {
      await trackVendorCycleOutcome({
        supplierCode: "VENDOR_X",
        succeededInCycle: 0,
        failedInCycle: 4,
        cycleStartedAtMs: Date.now(),
        sampleErrorMessage: "boom",
      });
    }
    // 6 failed cycles → still only 1 vendor_offline event.
    const offlineEvents = globalThis.__logCalls.filter(
      (c) =>
        (c[0] as { eventType: string }).eventType === "vendor_offline",
    );
    expect(offlineEvents).toHaveLength(1);
  });

  it("fires vendor_recovered with resolvedBy on first success after offline", async () => {
    const { trackVendorCycleOutcome } = await import("../run");
    // Drive into offline.
    for (let i = 0; i < 3; i++) {
      await trackVendorCycleOutcome({
        supplierCode: "VENDOR_X",
        succeededInCycle: 0,
        failedInCycle: 4,
        cycleStartedAtMs: Date.now(),
        sampleErrorMessage: "boom",
      });
    }
    const offlineCall = globalThis.__logCalls[0]![0] as {
      eventType: string;
    };
    expect(offlineCall.eventType).toBe("vendor_offline");
    // We know our mock resolver returns id=1000 for the first call.
    const offlineId = 1000;

    // Now succeed.
    await trackVendorCycleOutcome({
      supplierCode: "VENDOR_X",
      succeededInCycle: 4,
      failedInCycle: 0,
      cycleStartedAtMs: Date.now(),
      sampleErrorMessage: null,
    });

    expect(globalThis.__logCalls).toHaveLength(2);
    const recoveredCall = globalThis.__logCalls[1]![0] as {
      severity: string;
      eventType: string;
      vendorId: string;
      resolvedBy: number;
      context: { missed_cycles: number; offline_duration_ms: number };
    };
    expect(recoveredCall.severity).toBe("info");
    expect(recoveredCall.eventType).toBe("vendor_recovered");
    expect(recoveredCall.vendorId).toBe("VENDOR_X");
    expect(recoveredCall.resolvedBy).toBe(offlineId);
    expect(recoveredCall.context.missed_cycles).toBe(3);
    expect(recoveredCall.context.offline_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("does NOT fire vendor_recovered if vendor was never offline", async () => {
    const { trackVendorCycleOutcome } = await import("../run");
    // 2 failures (below threshold) then a success — no events at all.
    await trackVendorCycleOutcome({
      supplierCode: "VENDOR_X",
      succeededInCycle: 0,
      failedInCycle: 4,
      cycleStartedAtMs: Date.now(),
      sampleErrorMessage: "boom",
    });
    await trackVendorCycleOutcome({
      supplierCode: "VENDOR_X",
      succeededInCycle: 0,
      failedInCycle: 4,
      cycleStartedAtMs: Date.now(),
      sampleErrorMessage: "boom",
    });
    await trackVendorCycleOutcome({
      supplierCode: "VENDOR_X",
      succeededInCycle: 4,
      failedInCycle: 0,
      cycleStartedAtMs: Date.now(),
      sampleErrorMessage: null,
    });
    expect(globalThis.__logCalls).toHaveLength(0);
  });

  it("isolates state per vendor (one offline does not affect another)", async () => {
    const { trackVendorCycleOutcome } = await import("../run");
    // VENDOR_A goes offline.
    for (let i = 0; i < 3; i++) {
      await trackVendorCycleOutcome({
        supplierCode: "VENDOR_A",
        succeededInCycle: 0,
        failedInCycle: 1,
        cycleStartedAtMs: Date.now(),
        sampleErrorMessage: "boom",
      });
    }
    // VENDOR_B succeeds throughout — no events for it.
    await trackVendorCycleOutcome({
      supplierCode: "VENDOR_B",
      succeededInCycle: 5,
      failedInCycle: 0,
      cycleStartedAtMs: Date.now(),
      sampleErrorMessage: null,
    });
    expect(globalThis.__logCalls).toHaveLength(1);
    const call = globalThis.__logCalls[0]![0] as { vendorId: string };
    expect(call.vendorId).toBe("VENDOR_A");
  });
});
