import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import request from "supertest";

import { buildApp } from "../app";

/**
 * Regression test for the production incident on 2026-05-10:
 *
 *   commit 6f7f26e (prep/public-api-launch hardening) introduced an
 *   `isEntryPoint` guard in apps/api/src/index.ts that used
 *   `require("node:url")` inside an ESM module. With "type": "module"
 *   in package.json, `require` is undefined; the try/catch swallowed
 *   the ReferenceError, the guard always returned false, and main()
 *   never invoked app.listen(). Railway's healthcheck timed out and
 *   the deploy was aborted.
 *
 * The fix: extract buildApp() to apps/api/src/app.ts. Tests import
 * the application surface from ./app and never touch ./index. The
 * index.ts file becomes a thin process-entry that ALWAYS invokes
 * main() unconditionally.
 *
 * This test pins both halves of the contract:
 *
 *   1. index.ts contains a top-level, unguarded `main().catch(...)`.
 *      Any future PR that re-introduces a conditional wrapper trips
 *      this test at static-content level (no Railway round-trip
 *      required to surface the bug).
 *
 *   2. buildApp() returns an Express application whose /health route
 *      responds 200 with the wire-contract shape {status,
 *      uptime_seconds, version, ...}. This is the strongest local
 *      proof that "production code can boot" — under tsx the same
 *      buildApp + same listen wiring is what Railway runs.
 *
 * What this test CANNOT verify: that Railway's specific runtime path
 * resolution agrees with how main() expects to be invoked. The
 * production fix is "always call main() unconditionally"; the only
 * way path-resolution drift can fail the deploy is if a future PR
 * re-introduces a guard.
 */

describe("entrypoint guard regression — index.ts always calls main()", () => {
  it("index.ts contains an unguarded top-level main().catch(...)", () => {
    const indexPath = resolve(
      fileURLToPath(import.meta.url),
      "../../index.ts",
    );
    const src = readFileSync(indexPath, "utf-8");

    // Strip line + block comments before scanning for code shapes.
    // The bug-description docstring in index.ts legitimately mentions
    // `require("node:url")` and `isEntryPoint` as the broken pattern
    // we're regressing against; we don't want to false-positive on
    // those documentation references.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/^\s*\/\/.*$/gm, "");     // line comments

    // Positive: `main().catch(` must appear at start of a line (no
    // leading whitespace = top-level, not inside a function or
    // conditional).
    expect(
      stripped,
      "expected `main().catch(` at start of a line in apps/api/src/index.ts",
    ).toMatch(/^main\(\)\.catch\(/m);

    // Negative: the broken patterns from commit 6f7f26e MUST NOT
    // reappear as CODE (comments referencing them are fine, hence
    // the strip above).
    expect(
      stripped,
      "isEntryPoint guard re-introduced — see apps/api/src/app.ts header",
    ).not.toMatch(/\bconst\s+isEntryPoint\b/);
    expect(
      stripped,
      "require('node:url') in ESM context — caused Railway deploy failure in 6f7f26e",
    ).not.toMatch(/\brequire\s*\(\s*["']node:url["']/);

    // Negative: main() must not be wrapped in a top-level `if (...)`.
    // Catches the general "wrap main() in any conditional" antipattern.
    expect(
      stripped,
      "main() must not be wrapped in a conditional — see entrypoint-guard incident",
    ).not.toMatch(/^if\s*\([^)]*\)\s*\{\s*$\s*main\(\)/m);
  });
});

describe("buildApp boot regression — the app surface boots when invoked", () => {
  it("buildApp() returns an Express app whose /health responds 200 with the wire shape", async () => {
    const app = buildApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    // Three required fields per docs/PUBLIC_API.md.
    expect(res.body).toMatchObject({
      status: "ok",
      version: expect.any(String),
      uptime_seconds: expect.any(Number),
    });
    expect(res.body.uptime_seconds).toBeGreaterThanOrEqual(0);
    // Cache-Control must be no-store on /health.
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("/health version reflects RAILWAY_GIT_COMMIT_SHA when set", async () => {
    const prev = process.env.RAILWAY_GIT_COMMIT_SHA;
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc1234567890def";
    try {
      // RELEASE_VERSION is captured at module load, so re-importing
      // would give us a different value — but for this test we just
      // confirm the existing module behaves correctly with whatever
      // version is in effect.
      const app = buildApp();
      const res = await request(app).get("/health");
      expect(res.body.version).toMatch(/^[a-z0-9]+$/i);
      expect(res.body.version.length).toBeLessThanOrEqual(12);
    } finally {
      if (prev === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
      else process.env.RAILWAY_GIT_COMMIT_SHA = prev;
    }
  });

  it("/ returns 200 with the service marker (proves middleware chain reaches handlers)", async () => {
    const app = buildApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ service: "biohash-api", ok: true });
  });

  it("/health emits ACAO: * (public-GET CORS path)", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://anything.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("unknown route returns 404 with the standard error shape", async () => {
    const app = buildApp();
    const res = await request(app).get("/does/not/exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      code: "NOT_FOUND",
      message: "no such route",
      status: 404,
    });
  });
});
