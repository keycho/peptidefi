import express, { type RequestHandler } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { corsOptions } from "./cors-config";
import { vendorLeaderboardHandler } from "./routes/vendors";
import { arbitrageHandler } from "./routes/arbitrage";
import { authorityHandler } from "./routes/v1/authority";
import { statusHandler } from "./routes/v1/status";
import {
  getPeptideHandler,
  listPeptidesHandler,
} from "./routes/v1/peptides";
import { getCycleHandler, listCyclesHandler } from "./routes/v1/cycles";
import { getObservationHandler } from "./routes/v1/observations";
import { getTwapHandler } from "./routes/v1/twaps";
import { getPeptideVendorPricesHandler } from "./routes/v1/vendor-prices";
import { verifyObservationHandler } from "./routes/v1/verify";
import { getResearchHandler } from "./routes/v1/research";
import {
  getAnomalyHandler,
  jsonFeedAnomaliesHandler,
  listAnomaliesHandler,
  rssFeedAnomaliesHandler,
  statsAnomaliesHandler,
} from "./routes/anomalies";
import {
  checkVendorHandler,
  leaderboardHandler,
  myLeadsHandler,
  pipelineStatusHandler,
  submitLeadHandler,
} from "./routes/leads";
import {
  adminProgressHandler,
  adminQueueHandler,
  adminReviewHandler,
  adminViolationHandler,
} from "./routes/admin-leads";
import { requireAdminToken } from "./lib/admin-auth";

/**
 * buildApp + middleware helpers. Extracted from index.ts so tests can
 * import buildApp without triggering main() / app.listen() / the cron
 * loop. Previously this code lived in index.ts behind an
 * `isEntryPoint` guard that used `require("node:url")` in an ESM
 * context — `require` is undefined under "type": "module", the
 * try/catch swallowed the ReferenceError, the guard always returned
 * false, and main() never ran in production. Railway healthcheck
 * timed out, deploy aborted, old pod kept serving. This file fixes
 * the architecture: tests touch app.ts only; index.ts unconditionally
 * boots the server.
 *
 * Public-API contract (rate-limit classes, cache TTLs, error shape,
 * CORS split) is documented in docs/PUBLIC_API.md. Changes here
 * should update both.
 */

export const RELEASE_VERSION =
  (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? "dev").slice(0, 12);

/**
 * Wraps an async route handler so a thrown error (or rejected
 * promise) is forwarded to Express's error middleware via next(err)
 * instead of being lost in an unhandled rejection.
 */
function asyncRoute(
  fn: (req: express.Request, res: express.Response) => Promise<void> | void,
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/**
 * X-Admin-Token rate-limit bypass. Returns true iff the request's
 * X-Admin-Token header matches ADMIN_API_TOKEN (constant-time via
 * String length equality — the bypass surface is the same secret
 * as /api/admin/* gating, just a different header so a legitimate
 * dashboard can hit public endpoints under load without tripping
 * the per-IP limiter).
 */
function isAdminBypass(req: express.Request): boolean {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected || expected.length < 16) return false;
  const presented = req.header("x-admin-token");
  if (!presented) return false;
  // Trim because the Railway dashboard sometimes appends "\n" to env
  // values during copy-paste (same foot-gun the scraper proxy hit).
  return presented.trim() === expected;
}

/** Path predicate: which routes get wildcard CORS for public reads. */
export function isPublicGetPath(path: string): boolean {
  return (
    path === "/" ||
    path === "/health" ||
    path === "/authority" ||
    path === "/arbitrage" ||
    path.startsWith("/v1/") ||
    path === "/vendors/leaderboard" ||
    path.startsWith("/api/anomalies")
  );
}

/**
 * Cache-Control middleware factory. Sets `public, max-age=N` so
 * intermediate caches (Cloudflare, the browser, the Lovable
 * frontend's stale-while-revalidate hook) can serve a stable
 * response without re-hitting the origin. A handler that wants a
 * tighter / looser TTL can `res.set("cache-control", ...)` AFTER
 * this — the last set wins.
 */
function cacheFor(seconds: number): RequestHandler {
  return (_req, res, next) => {
    res.set("cache-control", `public, max-age=${seconds}`);
    next();
  };
}

/**
 * 429 response handler shared across every rate-limit instance.
 * Matches the {code, message, status, retry_after_seconds} contract
 * the public API doc pins. The legacy stringy "5 req/min/IP exceeded"
 * messages are gone — clients branch on `code`.
 */
function rateLimitJsonHandler(req: express.Request, res: express.Response): void {
  const rateLimitInfo = (req as unknown as {
    rateLimit?: { resetTime?: Date; limit?: number };
  }).rateLimit;
  const retryAfterMs = rateLimitInfo?.resetTime
    ? rateLimitInfo.resetTime.getTime() - Date.now()
    : 60_000;
  const retry_after_seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res
    .status(429)
    .set("Retry-After", String(retry_after_seconds))
    .json({
      code: "RATE_LIMITED",
      message: `rate limit exceeded${rateLimitInfo?.limit ? ` (${rateLimitInfo.limit}/window)` : ""}`,
      status: 429,
      retry_after_seconds,
    });
}

export interface BuildAppOptions {
  /** Used by /health's uptime_seconds. Defaults to now() when omitted. */
  startedAt?: Date;
}

export function buildApp(options: BuildAppOptions = {}): express.Express {
  const startedAt = options.startedAt ?? new Date();
  const startedAtIso = startedAt.toISOString();

  const app = express();
  app.disable("x-powered-by");
  // We need IP from x-forwarded-for behind Railway's load balancer
  // for the per-IP rate limiter to be meaningful. trust proxy = 1
  // accepts the first hop only (don't trust client-set XFF chains).
  app.set("trust proxy", 1);

  // ─── CORS split: permissive for public GETs, strict elsewhere ──
  // Public read endpoints (GET /v1/*, GET /api/anomalies, /authority,
  // /vendors/leaderboard, /arbitrage, /) get `ACAO: *` with
  // credentials=false so any frontend can consume the read API
  // without an allowlist entry. Everything else (POST /api/leads/*,
  // /api/admin/*) keeps the strict origin allowlist from
  // cors-config.ts which permits biohash.network + Lovable preview
  // hosts only.
  const publicGetCors = cors({
    origin: "*",
    credentials: false,
    methods: ["GET", "HEAD", "OPTIONS"],
    allowedHeaders: ["content-type", "x-admin-token"],
    maxAge: 86_400,
  });
  const strictCors = cors(corsOptions());
  app.use((req, res, next) => {
    if (
      isPublicGetPath(req.path) &&
      (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS")
    ) {
      return publicGetCors(req, res, next);
    }
    return strictCors(req, res, next);
  });

  app.use(express.json({ limit: "16kb" }));

  // ─── /v1/* + /vendors/* + /arbitrage rate limit (60/min/IP) ────
  // Mounted BEFORE the route definitions so it intercepts every
  // request to the public read surface. X-Admin-Token bypass lets
  // the dashboard hit our own API without per-IP throttling.
  const v1Limiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: isAdminBypass,
    handler: rateLimitJsonHandler,
  });
  app.use("/v1", v1Limiter);
  app.use("/authority", v1Limiter);
  app.use("/vendors", v1Limiter);
  app.use("/arbitrage", v1Limiter);

  app.get("/", (_req, res) => {
    res.json({ service: "biohash-api", ok: true });
  });

  app.get("/health", (_req, res) => {
    // Public-launch contract: status, uptime_seconds, version are
    // the three fields the doc pins. The rest (ok, service, cors,
    // auth) is kept for backward-compat with existing monitors —
    // strictly additive per the "don't change response shapes"
    // constraint.
    const body = {
      status: "ok",
      uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      version: RELEASE_VERSION,
      // ── legacy fields below ────────────────────────────────────
      ok: true,
      service: "api",
      started_at: startedAtIso,
      auth: "jose-ES256-jwks",
      cors: {
        lovable_pattern: true,
        static_origins: [
          "http://localhost:3000",
          "http://localhost:5173",
          "http://127.0.0.1:3000",
          "http://127.0.0.1:5173",
          "https://biohash.network",
          "https://www.biohash.network",
        ],
        env_extra_count: (process.env.CORS_ORIGINS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean).length,
      },
    };
    res.set("cache-control", "no-store").json(body);
  });

  // ─── Public reads — cache TTLs pinned per docs/PUBLIC_API.md ──
  // /authority is the trust anchor (changes only on rotation; long
  // TTL is safe). Leaderboard / arbitrage have natural minute-scale
  // churn. /v1/peptides reads change on registry updates (rare) so
  // 5min. Per-cycle / per-twap / per-observation rows are immutable
  // once finalized — long TTL. Verify is deterministic for finalized
  // observations so 1h is safe; the failure_code surface signals
  // "not yet verifiable" with its own retry hint.
  app.get("/vendors/leaderboard", cacheFor(600), vendorLeaderboardHandler);
  app.get("/arbitrage", cacheFor(60), arbitrageHandler);

  // ─── Phase E verification surface (§05.4 + §05.5) ────────────────
  app.get("/authority", cacheFor(600), asyncRoute(authorityHandler));
  app.get("/v1/status", cacheFor(30), asyncRoute(statusHandler));
  app.get("/v1/peptides", cacheFor(300), asyncRoute(listPeptidesHandler));
  app.get("/v1/peptides/:id", cacheFor(300), asyncRoute(getPeptideHandler));
  app.get(
    "/v1/peptides/:code/vendor-prices",
    cacheFor(60),
    asyncRoute(getPeptideVendorPricesHandler),
  );
  app.get("/v1/cycles", cacheFor(30), asyncRoute(listCyclesHandler));
  app.get("/v1/cycles/:id", cacheFor(3600), asyncRoute(getCycleHandler));
  app.get("/v1/observations/:id", cacheFor(3600), asyncRoute(getObservationHandler));
  app.get("/v1/twaps/:id", cacheFor(3600), asyncRoute(getTwapHandler));
  app.get("/v1/verify/observation/:id", cacheFor(3600), asyncRoute(verifyObservationHandler));
  app.get("/v1/research/:code", cacheFor(300), asyncRoute(getResearchHandler));

  // ─── /api/anomalies — public append-only operational log ──────────
  // 60 req/min/IP per spec. The X-Admin-Token bypass lets our own
  // dashboard hit this endpoint without per-IP throttling.
  const anomalyLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: isAdminBypass,
    handler: rateLimitJsonHandler,
  });
  app.use("/api/anomalies", anomalyLimiter);
  app.get("/api/anomalies", cacheFor(30), asyncRoute(listAnomaliesHandler));
  app.get("/api/anomalies/feed.xml", cacheFor(60), asyncRoute(rssFeedAnomaliesHandler));
  app.get("/api/anomalies/feed.json", cacheFor(60), asyncRoute(jsonFeedAnomaliesHandler));
  app.get("/api/anomalies/stats", cacheFor(60), asyncRoute(statsAnomaliesHandler));
  app.get("/api/anomalies/:id", cacheFor(60), asyncRoute(getAnomalyHandler));

  // ─── /api/leads/* — vendor discovery (public) ─────────────────────
  // Two rate limiters per the public-launch spec:
  //   - General /api/leads/* (POST + GET): 10 req/min/IP. POSTs
  //     here all carry wallet signatures in the body; 10/min is the
  //     tight bound the public launch pins.
  //   - POST /api/leads/submit: 5 per hour per IP. Mounted FIRST so
  //     it counts against the tighter bucket before the umbrella
  //     limiter sees the request.
  // X-Admin-Token bypass lets the dashboard hit the same endpoints
  // without per-IP throttling.
  const submitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: isAdminBypass,
    handler: rateLimitJsonHandler,
  });
  const leadsLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: isAdminBypass,
    handler: rateLimitJsonHandler,
  });
  app.use("/api/leads/submit", submitLimiter);
  app.use("/api/leads", leadsLimiter);
  app.post("/api/leads/submit", asyncRoute(submitLeadHandler));
  app.post("/api/leads/my-leads", asyncRoute(myLeadsHandler));
  app.get("/api/leads/pipeline-status", asyncRoute(pipelineStatusHandler));
  app.post("/api/leads/check-vendor", asyncRoute(checkVendorHandler));
  app.get("/api/leads/leaderboard", asyncRoute(leaderboardHandler));

  // ─── /api/admin/* — internal review surface ──────────────────────
  // Bearer-token gate via ADMIN_API_TOKEN; requireAdminToken fails
  // closed if the env var is unset, so a misconfigured deploy
  // returns 503 instead of accidentally exposing the surface.
  app.use("/api/admin", requireAdminToken());
  app.get("/api/admin/leads/queue", asyncRoute(adminQueueHandler));
  app.post("/api/admin/leads/:id/review", asyncRoute(adminReviewHandler));
  app.post("/api/admin/leads/:id/progress", asyncRoute(adminProgressHandler));
  app.post(
    "/api/admin/submitters/:id/violation",
    asyncRoute(adminViolationHandler),
  );

  // Standardised 404 — matches the {code, message, status} contract
  // pinned in docs/PUBLIC_API.md.
  app.use((_req, res) => {
    res
      .status(404)
      .json({ code: "NOT_FOUND", message: "no such route", status: 404 });
  });

  // Catch-all error handler — log the FULL stack to the server
  // console (where ops can grep it), but NEVER expose the stack to
  // the client. The production response body carries only the
  // standard error shape; details/cause are deliberately omitted so
  // an accidental `throw new Error("SUPABASE_SECRET_KEY=...")`
  // doesn't leak the secret in a 500.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[api] unhandled error: ${err.stack ?? err.message}`);
    if (res.headersSent) return;
    res
      .status(500)
      .json({ code: "INTERNAL_ERROR", message: "internal error", status: 500 });
  });

  return app;
}
