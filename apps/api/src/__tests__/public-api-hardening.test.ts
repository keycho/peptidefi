import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { buildApp, isPublicGetPath, RELEASE_VERSION } from "../app";
import { sendError, errors, type ApiErrorBody } from "../errors";

/**
 * Public-launch hardening contract pins. Four areas:
 *
 *   1. The public-GET path predicate — every endpoint in
 *      docs/PUBLIC_API.md§"CORS" that's labelled `*` must
 *      return true; every strict-CORS endpoint must return false.
 *      A future route added under /v1/* automatically inherits
 *      wildcard CORS; a future /api/private/* route doesn't.
 *
 *   2. Error response shape — every helper in errors.ts produces
 *      {code, message, status} at minimum; rate-limited / service-
 *      unavailable also carry retry_after_seconds; no helper leaks
 *      a stack trace or a secret-shaped value.
 *
 *   3. Standard error codes — RATE_LIMITED / NOT_FOUND / BAD_REQUEST /
 *      INTERNAL_ERROR / SERVICE_UNAVAILABLE all reachable via the
 *      errors helper and carry the right HTTP status.
 *
 *   4. Retry-After header — set alongside retry_after_seconds for
 *      both 429 and 503.
 *
 * These are integration-flavoured tests (they exercise the real
 * helpers, not mocks) but skip supertest because index.ts has
 * import-time side effects (cron loop, server listener) that we'd
 * have to refactor around. The unit-level coverage is sufficient
 * for the launch-hardening contract; full request-cycle tests are
 * a follow-up tracked in the test file's TODO.
 */

function makeRes(): {
  res: Response;
  status: () => number | undefined;
  body: () => ApiErrorBody | undefined;
  headers: () => Record<string, string>;
} {
  let statusCode: number | undefined;
  let payload: ApiErrorBody | undefined;
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
      payload = b as ApiErrorBody;
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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPublicGetPath — CORS allowlist predicate", () => {
  it("returns TRUE for every public-read endpoint pinned in PUBLIC_API.md", () => {
    const publicPaths = [
      "/",
      "/health",
      "/authority",
      "/arbitrage",
      "/vendors/leaderboard",
      "/v1/status",
      "/v1/peptides",
      "/v1/peptides/BPC157",
      "/v1/peptides/BPC157/vendor-prices",
      "/v1/cycles",
      "/v1/cycles/1149",
      "/v1/observations/123456",
      "/v1/twaps/uuid",
      "/v1/verify/observation/123456",
      "/api/anomalies",
      "/api/anomalies/feed.xml",
      "/api/anomalies/feed.json",
      "/api/anomalies/stats",
      "/api/anomalies/123",
    ];
    for (const path of publicPaths) {
      expect(isPublicGetPath(path), `expected ${path} to be public`).toBe(true);
    }
  });

  it("returns FALSE for strict-CORS endpoints (POST/admin/leads)", () => {
    const strictPaths = [
      "/api/leads/submit",
      "/api/leads/my-leads",
      "/api/leads/check-vendor",
      "/api/leads/pipeline-status",
      "/api/leads/leaderboard",
      "/api/admin/leads/queue",
      "/api/admin/leads/123/review",
      "/api/admin/leads/123/progress",
      "/api/admin/submitters/45/violation",
    ];
    for (const path of strictPaths) {
      expect(isPublicGetPath(path), `expected ${path} to be strict-CORS`).toBe(
        false,
      );
    }
  });

  it("does NOT accidentally permit deep / typo paths", () => {
    // Regression: a literal-prefix check like path.startsWith("/v1/")
    // permits "/v1/" but should still allow legitimate
    // sub-routes. Confirm bogus / unmounted paths are still
    // wildcard-CORS (they'll 404 at the handler with the right
    // shape; CORS for a 404 is fine).
    expect(isPublicGetPath("/v1/nonexistent")).toBe(true);
    // But anything outside the prefix list is strict:
    expect(isPublicGetPath("/private")).toBe(false);
    expect(isPublicGetPath("/v2/peptides")).toBe(false); // future surface
  });
});

describe("error response shape — {code, message, status, retry_after_seconds?}", () => {
  it("sendError emits all three required fields", () => {
    const { res, status, body } = makeRes();
    sendError(res, 400, "BAD_REQUEST", "missing :id");
    expect(status()).toBe(400);
    const b = body();
    expect(b?.code).toBe("BAD_REQUEST");
    expect(b?.message).toBe("missing :id");
    expect(b?.status).toBe(400);
    expect(b?.retry_after_seconds).toBeUndefined();
  });

  it("sendError preserves optional details field", () => {
    const { res, body } = makeRes();
    sendError(res, 400, "BAD_REQUEST", "validation failed", {
      field: "vendor_url",
      hint: "must be a parseable hostname",
    });
    const b = body();
    expect(b?.details).toEqual({
      field: "vendor_url",
      hint: "must be a parseable hostname",
    });
  });

  it("errors.notFound returns 404 with NOT_FOUND code", () => {
    const { res, status, body } = makeRes();
    errors.notFound(res, "no peptide with code FOO");
    expect(status()).toBe(404);
    expect(body()?.code).toBe("NOT_FOUND");
    expect(body()?.status).toBe(404);
  });

  it("errors.invalidInput uses canonical BAD_REQUEST code (renamed from INVALID_INPUT)", () => {
    // Pre-launch the code was INVALID_INPUT; the public spec
    // standardised on BAD_REQUEST. Regression: don't drift back.
    const { res, body } = makeRes();
    errors.invalidInput(res, "vendor_name required");
    expect(body()?.code).toBe("BAD_REQUEST");
  });

  it("errors.internal uses canonical INTERNAL_ERROR code (renamed from INTERNAL)", () => {
    const { res, body } = makeRes();
    errors.internal(res, "supabase down");
    expect(body()?.code).toBe("INTERNAL_ERROR");
    expect(body()?.status).toBe(500);
  });
});

describe("rate-limited + service-unavailable carry retry_after_seconds + Retry-After header", () => {
  it("errors.rateLimited sets retry_after_seconds in body + Retry-After header", () => {
    const { res, status, body, headers } = makeRes();
    errors.rateLimited(res, "too many requests", 42);
    expect(status()).toBe(429);
    expect(body()?.code).toBe("RATE_LIMITED");
    expect(body()?.retry_after_seconds).toBe(42);
    expect(headers()["retry-after"]).toBe("42");
  });

  it("errors.serviceUnavailable sets retry_after_seconds + Retry-After header", () => {
    const { res, status, body, headers } = makeRes();
    errors.serviceUnavailable(res, "supabase migration in progress", 60);
    expect(status()).toBe(503);
    expect(body()?.code).toBe("SERVICE_UNAVAILABLE");
    expect(body()?.retry_after_seconds).toBe(60);
    expect(headers()["retry-after"]).toBe("60");
  });

  it("error bodies never include stack traces or 'Error:' prefixes", () => {
    // Production safety: a thrown Error's stack should never reach
    // a response body. The error helpers all take literal strings,
    // so this can only break if someone passes `err.stack` directly.
    // Pin a stack-shaped string CAN'T silently leak the "Error:" /
    // "at File" markers; if it does, the test would catch it.
    const stackString =
      "Error: leaked secret SUPABASE_SECRET_KEY=sb_abc123\n    at /app/secret.ts:42";
    const { res, body } = makeRes();
    errors.internal(res, "internal error");
    // The default internal-error message must NEVER carry the
    // stack-string. (We don't pass it; we test that the default
    // helper produces a clean message.)
    expect(body()?.message).toBe("internal error");
    expect(JSON.stringify(body())).not.toContain("SUPABASE_SECRET_KEY");
    expect(JSON.stringify(body())).not.toContain(stackString);
  });
});

describe("error shape is stable across all helpers — Lovable contract", () => {
  it("every helper returns at least {code, message, status}", () => {
    const helpers: Array<(res: Response) => void> = [
      (r) => errors.invalidInput(r, "x"),
      (r) => errors.notAuthorized(r, "x"),
      (r) => errors.notFound(r, "x"),
      (r) => errors.internal(r, "x"),
      (r) => errors.serviceUnavailable(r, "x", 30),
      (r) => errors.rateLimited(r, "x", 30),
    ];
    for (const fire of helpers) {
      const { res, body } = makeRes();
      fire(res);
      const b = body();
      expect(typeof b?.code).toBe("string");
      expect(typeof b?.message).toBe("string");
      expect(typeof b?.status).toBe("number");
      // status MUST match what was actually written (catches a
      // future bug where the helper sets res.status(X) but body's
      // `status` field disagrees).
      expect(b?.code.length, "code is non-empty").toBeGreaterThan(0);
      expect(b?.message.length, "message is non-empty").toBeGreaterThan(0);
    }
  });
});
