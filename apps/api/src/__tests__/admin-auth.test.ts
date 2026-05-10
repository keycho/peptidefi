import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

import { requireAdminToken } from "../lib/admin-auth";

/**
 * Pin admin-auth's three failure paths and the happy path. The
 * middleware is the only line of defence on /api/admin/*; a
 * regression here exposes the entire admin surface.
 */

const ORIGINAL_ENV = process.env.ADMIN_API_TOKEN;

beforeEach(() => {
  delete process.env.ADMIN_API_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = ORIGINAL_ENV;
});

function makeReqRes(
  authHeader: string | undefined,
): {
  req: Request;
  res: Response;
  next: NextFunction;
  status: () => number | undefined;
  body: () => unknown;
  nextCalled: () => boolean;
} {
  let calledNext = false;
  let statusCode: number | undefined;
  let payload: unknown;
  const req = {
    header: (name: string) =>
      name.toLowerCase() === "authorization" ? authHeader : undefined,
  } as unknown as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(b: unknown) {
      payload = b;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    calledNext = true;
  };
  return {
    req,
    res,
    next,
    status: () => statusCode,
    body: () => payload,
    nextCalled: () => calledNext,
  };
}

describe("requireAdminToken", () => {
  it("fails closed with 503 when ADMIN_API_TOKEN is unset", () => {
    const mw = requireAdminToken();
    const t = makeReqRes("Bearer anything");
    mw(t.req, t.res, t.next);
    expect(t.status()).toBe(503);
    expect(t.nextCalled()).toBe(false);
    expect((t.body() as { code: string }).code).toBe("ADMIN_TOKEN_NOT_CONFIGURED");
  });

  it("fails closed when ADMIN_API_TOKEN is too short (<16 chars)", () => {
    process.env.ADMIN_API_TOKEN = "short";
    const mw = requireAdminToken();
    const t = makeReqRes("Bearer short");
    mw(t.req, t.res, t.next);
    expect(t.status()).toBe(503);
    expect(t.nextCalled()).toBe(false);
  });

  it("returns 401 with no Authorization header", () => {
    process.env.ADMIN_API_TOKEN = "a".repeat(32);
    const mw = requireAdminToken();
    const t = makeReqRes(undefined);
    mw(t.req, t.res, t.next);
    expect(t.status()).toBe(401);
    expect(t.nextCalled()).toBe(false);
    expect((t.body() as { code: string }).code).toBe("MISSING_BEARER");
  });

  it("returns 401 when scheme is not Bearer", () => {
    process.env.ADMIN_API_TOKEN = "a".repeat(32);
    const mw = requireAdminToken();
    const t = makeReqRes("Basic abcdef");
    mw(t.req, t.res, t.next);
    expect(t.status()).toBe(401);
  });

  it("returns 403 with a wrong token", () => {
    process.env.ADMIN_API_TOKEN = "a".repeat(32);
    const mw = requireAdminToken();
    const t = makeReqRes("Bearer " + "b".repeat(32));
    mw(t.req, t.res, t.next);
    expect(t.status()).toBe(403);
    expect((t.body() as { code: string }).code).toBe("BAD_BEARER");
  });

  it("returns 403 on length mismatch (rejects short prefix-of-real)", () => {
    process.env.ADMIN_API_TOKEN = "a".repeat(32);
    const mw = requireAdminToken();
    const t = makeReqRes("Bearer " + "a".repeat(16));
    mw(t.req, t.res, t.next);
    expect(t.status()).toBe(403);
  });

  it("calls next() on the correct token", () => {
    process.env.ADMIN_API_TOKEN = "secret-admin-token-32-chars-long!";
    const mw = requireAdminToken();
    const t = makeReqRes(`Bearer secret-admin-token-32-chars-long!`);
    mw(t.req, t.res, t.next);
    expect(t.nextCalled()).toBe(true);
    expect(t.status()).toBeUndefined();
  });

  it("tolerates whitespace around the token after Bearer", () => {
    process.env.ADMIN_API_TOKEN = "secret-admin-token-32-chars-long!";
    const mw = requireAdminToken();
    const t = makeReqRes(`Bearer    secret-admin-token-32-chars-long!  `);
    // The regex captures from the first non-space; trim() handles the trailing.
    mw(t.req, t.res, t.next);
    expect(t.nextCalled()).toBe(true);
  });
});
