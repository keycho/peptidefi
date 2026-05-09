import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * Regression: the stats handler used to misread a zero-error-count
 * result as a query failure and return:
 *
 *   {"code":"DB_ERROR","message":"stats query failed: 0"}
 *
 * Cause: severityCountsSince() returned `SeverityCounts | { error
 * string }`. Both branches had an `error` property (the count branch
 * has `error: number` for severity='error' counts; the failure
 * branch had `error: string` for the message). The discriminator
 * `"error" in r` matched both, so when a healthy window had zero
 * error-severity events the handler treated `r.error === 0` as the
 * error message.
 *
 * Fix: throw on DB failure, catch in handler, log the full error
 * (message + stack + cause) to console.error and surface
 * error.message in the response.
 *
 * These tests pin both:
 *   1. Handler returns 200 + stats body when all three queries
 *      succeed AND the rows contain zero severity='error' events.
 *   2. Handler returns 500 with the actual PostgREST error message
 *      (not "0", not stringified `[object Object]`) when the query
 *      fails — and writes the full error to console.error.
 */

// Hoisted-safe mock factory. Each test installs its own resolver
// before calling the handler.
vi.mock("../supabase", () => {
  return {
    adminClientUntyped: () => ({
      from: () => ({
        select: () => ({
          gte: (_col: string, _val: string) =>
            globalThis.__statsResolver!(_val),
          // The "all_time" branch calls .select() and awaits the
          // builder directly without .gte(). Make the builder itself
          // a thenable.
          then: (
            onFulfilled: (
              v: { data: Array<{ severity: string }> | null; error: unknown },
            ) => void,
          ) => onFulfilled(globalThis.__statsResolver!(null)),
        }),
      }),
    }),
  };
});

declare global {
  // eslint-disable-next-line no-var
  var __statsResolver:
    | ((sinceIso: string | null) => {
        data: Array<{ severity: string }> | null;
        error: unknown;
      })
    | undefined;
}

afterEach(() => {
  globalThis.__statsResolver = undefined;
  // Clear the in-memory stats cache between tests.
  return import("../routes/anomalies").then((m) =>
    m._resetStatsCacheForTests(),
  );
});

function makeRes(): {
  res: Response;
  status: () => number | undefined;
  body: () => unknown;
  headers: () => Record<string, string>;
} {
  let statusCode: number | undefined;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    json(b: unknown) {
      payload = b;
      return this;
    },
  } as unknown as Response;
  return {
    res,
    status: () => statusCode,
    body: () => payload,
    headers: () => headers,
  };
}

describe("statsAnomaliesHandler regression", () => {
  it("returns 200 with stats body even when zero events have severity='error'", async () => {
    // ALL three windows return only info events. counts.error === 0
    // for every window — exactly the case that previously short-
    // circuited into a 500 response.
    globalThis.__statsResolver = () => ({
      data: [
        { severity: "info" },
        { severity: "info" },
        { severity: "warn" },
      ],
      error: null,
    });

    const { statsAnomaliesHandler } = await import("../routes/anomalies");
    const { res, status, body } = makeRes();
    await statsAnomaliesHandler({} as Request, res);

    expect(status()).toBeUndefined();
    const b = body() as {
      last_24h: { info: number; warn: number; error: number; critical: number };
      last_7d: { info: number; warn: number; error: number; critical: number };
      all_time: { info: number; warn: number; error: number; critical: number };
      generated_at: string;
    };
    expect(b.last_24h).toEqual({ info: 2, warn: 1, error: 0, critical: 0 });
    expect(b.last_7d).toEqual({ info: 2, warn: 1, error: 0, critical: 0 });
    expect(b.all_time).toEqual({ info: 2, warn: 1, error: 0, critical: 0 });
    expect(typeof b.generated_at).toBe("string");
  });

  it("counts severity='error' events without confusing them with query failures", async () => {
    globalThis.__statsResolver = () => ({
      data: [
        { severity: "info" },
        { severity: "error" },
        { severity: "error" },
        { severity: "critical" },
      ],
      error: null,
    });

    const { statsAnomaliesHandler } = await import("../routes/anomalies");
    const { res, status, body } = makeRes();
    await statsAnomaliesHandler({} as Request, res);

    expect(status()).toBeUndefined();
    const b = body() as {
      last_24h: { info: number; error: number; critical: number };
    };
    expect(b.last_24h.error).toBe(2);
    expect(b.last_24h.critical).toBe(1);
    expect(b.last_24h.info).toBe(1);
  });

  it("returns 500 with the actual PostgREST message + logs full error on query failure", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const pgErr = {
      message: "permission denied for table anomalies",
      code: "42501",
      details: null,
      hint: null,
    };
    globalThis.__statsResolver = () => ({ data: null, error: pgErr });

    const { statsAnomaliesHandler } = await import("../routes/anomalies");
    const { res, status, body } = makeRes();
    await statsAnomaliesHandler({} as Request, res);

    expect(status()).toBe(500);
    const b = body() as { code: string; message: string; details?: { cause?: string } };
    expect(b.code).toBe("DB_ERROR");
    // Critically: must NOT contain literal "0" or "[object Object]".
    expect(b.message).toContain("permission denied for table anomalies");
    expect(b.message).not.toMatch(/\b0\b/);
    expect(b.details?.cause).toBe("permission denied for table anomalies");

    // console.error must have received the structured error so ops
    // can pull message + stack + cause from logs.
    expect(consoleErr).toHaveBeenCalled();
    const call = consoleErr.mock.calls[0]!;
    expect(call[0]).toContain("[anomalies/stats] query failed");
    const meta = call[1] as { message: string; stack: unknown; cause: unknown };
    expect(meta.cause).toBe(pgErr);

    consoleErr.mockRestore();
  });
});
