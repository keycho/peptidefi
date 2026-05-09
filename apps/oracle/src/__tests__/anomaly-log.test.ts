import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAnomalyLogForTests as _resetForTests,
  initAnomalyLog,
  logAnomaly,
} from "@peptide-oracle/shared";

/**
 * The anomaly logger has two non-negotiable invariants:
 *
 *   1. Never throws. A caller `await logAnomaly(...)` must never
 *      take down the oracle pipeline, regardless of Supabase
 *      reachability.
 *   2. Never blocks indefinitely. A hung supabase backend must time
 *      out so the oracle's TWAP/cycle commits keep progressing.
 *
 * These tests pin both. The Supabase JS client is intercepted via a
 * vi.mock — we never touch the network.
 */

// vi.mock factory must be hoisted-able. Build a configurable mock
// inside the factory and expose its handles via a global.
vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: () => ({
      from: () => ({
        insert: () => ({
          select: () => ({
            single: () => globalThis.__supabaseInsertResolver!(),
          }),
        }),
      }),
    }),
  };
});

declare global {
  // eslint-disable-next-line no-var
  var __supabaseInsertResolver:
    | (() => Promise<{ data: { id: number } | null; error: { message: string } | null }>)
    | undefined;
}

beforeEach(() => {
  _resetForTests();
  globalThis.__supabaseInsertResolver = async () => ({
    data: { id: 42 },
    error: null,
  });
});

afterEach(() => {
  _resetForTests();
});

describe("anomalyLog invariants", () => {
  it("returns null and warns when called before init (does not throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await logAnomaly({
      severity: "info",
      eventType: "x",
      description: "y",
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns the inserted row id on success", async () => {
    initAnomalyLog({ url: "http://stub", key: "stub", service: "test" });
    const result = await logAnomaly({
      severity: "info",
      eventType: "x",
      description: "y",
    });
    expect(result).toEqual({ id: 42 });
  });

  it("returns null when Supabase reports an error (does not throw)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.__supabaseInsertResolver = async () => ({
      data: null,
      error: { message: "RLS denied" },
    });
    initAnomalyLog({ url: "http://stub", key: "stub", service: "test" });
    const result = await logAnomaly({
      severity: "error",
      eventType: "x",
      description: "y",
    });
    expect(result).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("returns null when the insert promise rejects (does not throw)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.__supabaseInsertResolver = async () => {
      throw new Error("ECONNRESET");
    };
    initAnomalyLog({ url: "http://stub", key: "stub", service: "test" });
    const result = await logAnomaly({
      severity: "error",
      eventType: "x",
      description: "y",
    });
    expect(result).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("returns null on timeout when Supabase hangs (does not block forever)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // Resolver never resolves — the timeout race must win.
    globalThis.__supabaseInsertResolver = () => new Promise(() => {});
    initAnomalyLog({
      url: "http://stub",
      key: "stub",
      service: "test",
      insertTimeoutMs: 50,
    });
    const start = Date.now();
    const result = await logAnomaly({
      severity: "error",
      eventType: "x",
      description: "y",
    });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Allow generous slack so this isn't flaky on slow CI.
    expect(elapsed).toBeLessThan(500);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("init is idempotent — second init keeps first config", async () => {
    initAnomalyLog({ url: "http://a", key: "k", service: "test" });
    initAnomalyLog({ url: "http://b", key: "k", service: "test" });
    // No way to inspect URL directly without exposing more internals;
    // just assert that double-init doesn't throw and the logger
    // continues to work.
    const result = await logAnomaly({
      severity: "info",
      eventType: "x",
      description: "y",
    });
    expect(result).toEqual({ id: 42 });
  });
});
