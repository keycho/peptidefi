import "dotenv/config";
import express from "express";
import cors from "cors";
import { corsOptions } from "./cors-config";
import { vendorLeaderboardHandler } from "./routes/vendors";
import { arbitrageHandler } from "./routes/arbitrage";

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

function buildApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: "16kb" }));

  app.get("/", (_req, res) => {
    res.json({ service: "peptide-oracle-api", ok: true });
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
