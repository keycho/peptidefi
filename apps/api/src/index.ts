import "dotenv/config";
import { initAnomalyLog, logAnomaly } from "@peptide-oracle/shared";
import { adminClientUntyped } from "./supabase";
import { buildApp } from "./app";
import { startLeadExpiryLoop } from "./lib/lead-expiry";

/**
 * peptide-oracle API — Express server entrypoint.
 *
 * The application surface itself lives in ./app (buildApp + route
 * registration + middleware). This file owns process-level concerns
 * only: dotenv, anomaly-log init, signal-handler wiring, the lead-
 * expiry cron, and the actual server.listen().
 *
 * Why the split: pre-split this file gated `main()` behind an
 * `isEntryPoint` check that used `require("node:url")` in an ESM
 * context. Under `"type": "module"`, `require` is undefined, the
 * try/catch swallowed the ReferenceError, the guard always returned
 * false, and main() never ran in production. Railway healthcheck
 * timed out, deploy aborted. Now main() runs unconditionally; tests
 * import buildApp from ./app and never touch this file.
 *
 * Port resolution: process.env.PORT first (Railway injects this),
 * then API_PORT (our own convention), then default 3000.
 */

const apiPort = Number.parseInt(
  process.env.PORT ?? process.env.API_PORT ?? "3000",
  10,
);

const startedAt = new Date();

let stopRequested = false;
function requestShutdown(signal: string): void {
  if (stopRequested) return;
  stopRequested = true;
  console.log(`\n[shutdown] ${signal} received — draining and exiting`);
}
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

async function main(): Promise<void> {
  // Wire the append-only anomaly log so /api/leads/* events
  // (lead_submitted etc.) reach Supabase. Same singleton init
  // pattern as the oracle/scraper/worker.
  {
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (url && key) {
      initAnomalyLog({ url, key, service: "api" });
      void logAnomaly({
        severity: "info",
        eventType: "api_started",
        description: "api process started",
        context: {
          node_version: process.version,
          admin_token_configured:
            (process.env.ADMIN_API_TOKEN ?? "").length >= 16,
        },
      });
    } else {
      console.warn(
        "[startup] SUPABASE_URL or SUPABASE_SECRET_KEY missing; anomaly log disabled (events will console.warn)",
      );
    }
  }

  const app = buildApp({ startedAt });

  const server = app.listen(apiPort, "0.0.0.0", () => {
    console.log(
      `[startup] api listening on :${apiPort}, /health on same port, auth=jose-ES256-jwks`,
    );
  });

  // Lead-expiry sweeper. Every 6h: auto-reject submitted >14d, mark
  // expired accepted_pipeline >60d, mark expired vendor_responded
  // >30d. AbortSignal-tied so SIGTERM cleanly stops the timer.
  const expiryAbort = new AbortController();
  startLeadExpiryLoop({
    supabase: adminClientUntyped(),
    signal: expiryAbort.signal,
  });

  await new Promise<void>((resolve) => {
    const check = () => {
      if (stopRequested) resolve();
      else setTimeout(check, 250);
    };
    check();
  });

  expiryAbort.abort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log("[shutdown] clean exit");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
