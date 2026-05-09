import "dotenv/config";
import express from "express";
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
import {
  getAnomalyHandler,
  jsonFeedAnomaliesHandler,
  listAnomaliesHandler,
  rssFeedAnomaliesHandler,
  statsAnomaliesHandler,
} from "./routes/anomalies";

/**
 * peptide-oracle API — Express server.
 *
 * Single port (API_PORT, default 3000), single Express app. Public
 * read-only oracle reads (vendors, arbitrage) and the Railway
 * healthcheck (/health) live here.
 *
 * The surface is intentionally small at this stage: just the public
 * read endpoints over the scraping/TWAP layer — meant to grow into
 * the on-chain peptide oracle product.
 *
 * Why one port (different from scraper/worker which use two): Railway
 * assigns one public port per service and runs its healthcheck against
 * the same port. The scraper and worker have no public API surface,
 * so their standalone HEALTH_PORT server (from @peptide-oracle/shared)
 * makes sense for them.
 *
 * Auth model: authRequired middleware is preserved in src/auth.ts for
 * future protected oracle endpoints (admin commits, paid API tiers).
 * No protected routes today, so it isn't imported here.
 *
 * Port resolution: process.env.PORT first (Railway injects this), then
 * API_PORT (our own convention), then default 3000.
 */

const apiPort = Number.parseInt(
  process.env.PORT ?? process.env.API_PORT ?? "3000",
  10,
);

interface HealthSnapshot {
  ok: true;
  service: "api";
  started_at: string;
  uptime_seconds: number;
  auth: "jose-ES256-jwks";
  cors: { lovable_pattern: true; static_origins: string[]; env_extra_count: number };
}

const startedAt = new Date();
const startedAtIso = startedAt.toISOString();

let stopRequested = false;
function requestShutdown(signal: string): void {
  if (stopRequested) return;
  stopRequested = true;
  console.log(`\n[shutdown] ${signal} received — draining and exiting`);
}
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

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

function buildApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: "16kb" }));

  app.get("/", (_req, res) => {
    res.json({ service: "biohash-api", ok: true });
  });

  app.get("/health", (_req, res) => {
    const snapshot: HealthSnapshot = {
      ok: true,
      service: "api",
      started_at: startedAtIso,
      uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
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
    res.set("cache-control", "no-store").json(snapshot);
  });

  // Public oracle reads (no auth).
  app.get("/vendors/leaderboard", vendorLeaderboardHandler);
  app.get("/arbitrage", arbitrageHandler);

  // ─── Phase E verification surface (§05.4 + §05.5) ────────────────
  // /authority is the trust-anchor endpoint — what every verifier
  // hits first to learn which Solana cluster + signing pubkey to
  // expect. /v1/* are the read + verify endpoints.
  app.get("/authority", asyncRoute(authorityHandler));
  app.get("/v1/status", asyncRoute(statusHandler));
  app.get("/v1/peptides", asyncRoute(listPeptidesHandler));
  app.get("/v1/peptides/:id", asyncRoute(getPeptideHandler));
  app.get(
    "/v1/peptides/:code/vendor-prices",
    asyncRoute(getPeptideVendorPricesHandler),
  );
  app.get("/v1/cycles", asyncRoute(listCyclesHandler));
  app.get("/v1/cycles/:id", asyncRoute(getCycleHandler));
  app.get("/v1/observations/:id", asyncRoute(getObservationHandler));
  app.get("/v1/twaps/:id", asyncRoute(getTwapHandler));
  app.get("/v1/verify/observation/:id", asyncRoute(verifyObservationHandler));

  // ─── /api/anomalies — public append-only operational log ──────────
  // Rate-limited per-IP because this endpoint is intentionally public
  // (no auth) and the stats / feed paths could be hit aggressively
  // by a poorly-written client. 60 req/min/IP per spec; well above
  // any reasonable Lovable polling cadence.
  const anomalyLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { code: "RATE_LIMITED", message: "60 req/min/IP exceeded" },
  });
  app.use("/api/anomalies", anomalyLimiter);
  app.get("/api/anomalies", asyncRoute(listAnomaliesHandler));
  app.get("/api/anomalies/feed.xml", asyncRoute(rssFeedAnomaliesHandler));
  app.get("/api/anomalies/feed.json", asyncRoute(jsonFeedAnomaliesHandler));
  app.get("/api/anomalies/stats", asyncRoute(statsAnomaliesHandler));
  app.get("/api/anomalies/:id", asyncRoute(getAnomalyHandler));

  app.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "no such route" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[api] unhandled error: ${err.stack ?? err.message}`);
    if (res.headersSent) return;
    res.status(500).json({ code: "INTERNAL", message: "internal error" });
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildApp();

  const server = app.listen(apiPort, "0.0.0.0", () => {
    console.log(
      `[startup] api listening on :${apiPort}, /health on same port, auth=jose-ES256-jwks`,
    );
  });

  await new Promise<void>((resolve) => {
    const check = () => {
      if (stopRequested) resolve();
      else setTimeout(check, 250);
    };
    check();
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log("[shutdown] clean exit");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
