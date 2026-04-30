import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRequired } from "./auth";
import { corsOptions } from "./cors-config";
import { balanceHandler } from "./routes/balance";
import { leaderboardHandler } from "./routes/leaderboard";
import {
  closePositionHandler,
  getPositionHandler,
  listPositionsHandler,
  openPositionHandler,
} from "./routes/positions";
import {
  getProfileHandler,
  updateDisplayNameHandler,
} from "./routes/profile";
import { vendorLeaderboardHandler } from "./routes/vendors";
import { arbitrageHandler } from "./routes/arbitrage";
import {
  getPredictionHandler,
  listMyBetsHandler,
  listPredictionsHandler,
  placeBetHandler,
  resolveMarketHandler,
} from "./routes/predictions";

/**
 * PeptideFi API — Express server.
 *
 * Single port (API_PORT, default 3000), single Express app. Both the
 * user-facing routes (/balance, future /positions/*, /balance/check-grants)
 * and the Railway healthcheck (/health) live here.
 *
 * Why one port (different from scraper/worker which use two): Railway
 * assigns one public port per service and runs its healthcheck against
 * the same port. A separate "internal-only" health port can't actually
 * be reached by Railway's healthcheck, so the second listener was just
 * dead weight here. The scraper and worker have no public API surface,
 * so their standalone HEALTH_PORT server (from @peptidefi/shared) makes
 * sense for them — Railway just routes the healthcheck port to the
 * standalone server.
 *
 * Auth model: every protected route mounts the authRequired middleware
 * which verifies the Bearer JWT locally with HS256 + SUPABASE_JWT_SECRET
 * and attaches req.user.id (the Supabase auth.users.id, also the
 * public.users.id). user_id is NEVER read from the request body or
 * query — only from the verified JWT sub claim.
 *
 * Port resolution: process.env.PORT first (Railway injects this), then
 * API_PORT (our own convention), then default 3000.
 *
 * Graceful shutdown: SIGTERM/SIGINT closes the server, lets in-flight
 * requests finish naturally, then exits 0. Railway sends SIGTERM during
 * deploys with a typical 30s grace window — Express's server.close()
 * stops accepting new connections immediately and waits for in-flight
 * to drain.
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

function buildApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: "16kb" }));

  // Public root — handy for "is the URL right?" checks.
  app.get("/", (_req, res) => {
    res.json({ service: "peptidefi-api", ok: true });
  });

  // Healthcheck (public, no auth). Railway hits this on API_PORT during
  // deploy verification. Returns 200 + JSON snapshot of process state.
  // Kept on the same Express server as the user routes so Railway's
  // single-port healthcheck model works without a separate listener.
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
          "https://biohack.market",
          "https://www.biohack.market",
        ],
        env_extra_count: (process.env.CORS_ORIGINS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean).length,
      },
    };
    res.set("cache-control", "no-store").json(snapshot);
  });

  // Public routes (no auth).
  app.get("/leaderboard", leaderboardHandler);
  app.get("/vendors/leaderboard", vendorLeaderboardHandler);
  app.get("/arbitrage", arbitrageHandler);
  app.get("/predictions", listPredictionsHandler);
  // /predictions/me MUST be registered before /predictions/:slug so the
  // literal route wins. Express matches in order; without this, "me"
  // would be captured as a slug and getPredictionHandler would 404.
  app.get("/predictions/me", authRequired, listMyBetsHandler);
  app.get("/predictions/:slug", getPredictionHandler);

  // Protected routes — authRequired applied per route, so unknown paths
  // fall through to the 404 handler instead of being challenged for
  // credentials they shouldn't even need.
  app.get("/balance", authRequired, balanceHandler);
  app.post("/positions/open", authRequired, openPositionHandler);
  app.post("/positions/:id/close", authRequired, closePositionHandler);
  app.get("/positions", authRequired, listPositionsHandler);
  app.get("/positions/:id", authRequired, getPositionHandler);
  app.get("/profile", authRequired, getProfileHandler);
  app.patch("/profile/display-name", authRequired, updateDisplayNameHandler);
  app.post("/predictions/:slug/bet", authRequired, placeBetHandler);
  app.post("/admin/predictions/:slug/resolve", authRequired, resolveMarketHandler);

  // 404 for anything not matched above.
  app.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "no such route" });
  });

  // Last-resort error handler. Keeps the process alive on synchronous
  // throws inside route handlers; async throws should be caught locally
  // but this is the safety net.
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

  // Wait for shutdown signal.
  await new Promise<void>((resolve) => {
    const check = () => {
      if (stopRequested) resolve();
      else setTimeout(check, 250);
    };
    check();
  });

  // Drain. Express's server.close() stops accepting new connections and
  // waits for in-flight to finish.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log("[shutdown] clean exit");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
