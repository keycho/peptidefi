import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  type HealthState,
  startHealthServer,
} from "@peptidefi/shared";
import { authRequired } from "./auth";
import { corsOptions } from "./cors-config";
import { balanceHandler } from "./routes/balance";

/**
 * PeptideFi API — Express server.
 *
 * Two ports:
 *   - API_PORT      (default 3000) — user-facing routes (/balance, future
 *                                    /positions/*, /balance/check-grants)
 *   - HEALTH_PORT   (default 8080) — Railway-only /health JSON snapshot
 *
 * They're separate so an attacker can't reach the cycle/health metadata
 * via the public API surface, and so Railway's healthcheck has its own
 * port that's never accidentally exposed via CORS.
 *
 * Auth model: every protected route mounts the authRequired middleware
 * which verifies the Bearer JWT locally with HS256 + SUPABASE_JWT_SECRET
 * and attaches req.user.id (the Supabase auth.users.id, also the
 * public.users.id). user_id is NEVER read from the request body or
 * query — only from the verified JWT sub claim.
 *
 * Graceful shutdown: SIGTERM/SIGINT closes both servers, lets in-flight
 * requests finish naturally, then exits 0. Railway sends SIGTERM during
 * deploys with a typical 30s grace window — Express's server.close()
 * stops accepting new connections immediately and waits for in-flight
 * to drain.
 */

const apiPort = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const healthPort = Number.parseInt(process.env.HEALTH_PORT ?? "8080", 10);

const startedAt = new Date().toISOString();
const health: HealthState = {
  service: "api",
  started_at: startedAt,
  cycles_completed: 0, // not a cyclic service; fields kept for shape parity
  cycles_failed: 0,
  last_cycle_started_at: null,
  last_cycle_finished_at: null,
  last_cycle_status: "ready",
  last_cycle_duration_ms: null,
};

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

  // Public root — handy for "is the URL right?" checks. Not the healthcheck.
  app.get("/", (_req, res) => {
    res.json({ service: "peptidefi-api", ok: true });
  });

  // Protected routes — authRequired applied per route, so unknown paths
  // fall through to the 404 handler instead of being challenged for
  // credentials they shouldn't even need.
  app.get("/balance", authRequired, balanceHandler);

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

  // Start the user-facing API server.
  const apiServer = app.listen(apiPort, "0.0.0.0", () => {
    console.log(`[startup] api listening on :${apiPort}`);
  });

  // Start the Railway healthcheck server on a separate port.
  const healthServer = startHealthServer({
    port: healthPort,
    state: () => health,
    // The API isn't cyclic — it's healthy as long as it's accepting
    // connections. Use a long staleAfterMs so we never go unhealthy
    // just because nothing's pinged us recently.
    staleAfterMs: 24 * 60 * 60 * 1000,
  });
  console.log(`[startup] health endpoint on :${healthPort}/health`);

  // Wait for shutdown signal.
  await new Promise<void>((resolve) => {
    const check = () => {
      if (stopRequested) resolve();
      else setTimeout(check, 250);
    };
    check();
  });

  // Drain. Express's server.close() stops accepting new connections and
  // waits for in-flight to finish. healthServer.close() does the same.
  await Promise.all([
    new Promise<void>((resolve) => apiServer.close(() => resolve())),
    new Promise<void>((resolve) => healthServer.close(() => resolve())),
  ]);
  console.log("[shutdown] clean exit");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
