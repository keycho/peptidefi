import "dotenv/config";
import {
  type HealthState,
  sleepInterruptible,
  startHealthServer,
} from "@peptidefi/shared";
import { runOnce } from "./run";

/**
 * CLI entry. Two modes:
 *   pnpm dev / pnpm start  — loop forever, sleeping SCRAPER_CYCLE_INTERVAL_MS
 *                            between cycles (default 60s). Used in dev and
 *                            on Railway.
 *   pnpm once / --once     — run a single cycle and exit. Used for manual
 *                            testing, debugging, and from scripts.
 *
 * Cycle interval env var: SCRAPER_CYCLE_INTERVAL_MS is canonical; the older
 * SCRAPE_INTERVAL_MS is read as a fallback. Default 60000.
 *
 * Set SCRAPER_CYCLE_INTERVAL_MS=600000 (10 min) during ScrapingAnt
 * free-tier soak to stretch the 10k credit pool across ~7 days at ~6
 * credits/cycle.
 *
 * Health endpoint: HTTP GET /health on HEALTH_PORT (default 8080) returns
 * a JSON snapshot of cycle state. Healthy iff the last cycle finished
 * within 2× the cycle interval (one missed cycle tolerated). Railway uses
 * this for deployment health checks.
 *
 * Graceful shutdown: SIGTERM/SIGINT abort the inter-cycle sleep (so a
 * 10-minute scraper sleep doesn't blow Railway's typical 30s grace
 * window), let the in-flight cycle finish, close the health server, and
 * exit 0. We never leave a scraper_runs row stuck in 'running'.
 */
const intervalMs = Number.parseInt(
  process.env.SCRAPER_CYCLE_INTERVAL_MS ??
    process.env.SCRAPE_INTERVAL_MS ??
    "60000",
  10,
);

const healthPort = Number.parseInt(process.env.HEALTH_PORT ?? "8080", 10);

const runOnceFlag = process.argv.includes("--once");

const startedAt = new Date().toISOString();
const health: HealthState = {
  service: "scraper",
  started_at: startedAt,
  cycles_completed: 0,
  cycles_failed: 0,
  last_cycle_started_at: null,
  last_cycle_finished_at: null,
  last_cycle_status: null,
  last_cycle_duration_ms: null,
};

const shutdownAbort = new AbortController();
let stopRequested = false;
function requestShutdown(signal: string): void {
  if (stopRequested) return;
  stopRequested = true;
  console.log(`\n[shutdown] ${signal} received — finishing current cycle, then exiting`);
  shutdownAbort.abort();
}
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

function fmtSummary(s: Awaited<ReturnType<typeof runOnce>>): string {
  return [
    `run=${s.runId}`,
    `status=${s.status}`,
    `${s.succeeded}/${s.attempted} ok`,
    `${s.failed} failed`,
    `${s.durationMs}ms`,
    s.proxyEnabled
      ? `proxy=on credits_session=${s.proxyCreditsSession}`
      : "proxy=off",
    s.errorSummary ? `errors=${s.errorSummary}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function safeCycle(): Promise<void> {
  health.last_cycle_started_at = new Date().toISOString();
  try {
    const summary = await runOnce();
    console.log(`[cycle] ${fmtSummary(summary)}`);
    health.cycles_completed += 1;
    health.last_cycle_status = summary.status;
    health.last_cycle_duration_ms = summary.durationMs;
    health.extra = {
      proxy_enabled: summary.proxyEnabled,
      proxy_credits_session: summary.proxyCreditsSession,
    };
  } catch (err) {
    // runOnce traps all per-product errors. A throw here means an
    // infrastructure failure (Supabase unreachable, env missing, etc.).
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[cycle] FAILED ${msg}`);
    health.cycles_failed += 1;
    health.last_cycle_status = "failed";
  } finally {
    health.last_cycle_finished_at = new Date().toISOString();
  }
}

async function main(): Promise<void> {
  // Health server is up for both --once and loop modes; --once just exits
  // before the next cycle would run, so the server lifetime is brief there.
  const healthServer = startHealthServer({
    port: healthPort,
    state: () => health,
    staleAfterMs: intervalMs * 2,
  });
  console.log(`[startup] health endpoint on :${healthPort}/health`);

  try {
    if (runOnceFlag) {
      await safeCycle();
      return;
    }

    console.log(
      `[startup] scraper looping on ${intervalMs}ms interval (--once for a single cycle)`,
    );
    while (!stopRequested) {
      await safeCycle();
      if (stopRequested) break;
      await sleepInterruptible(intervalMs, shutdownAbort.signal);
    }
    console.log("[shutdown] clean exit");
  } finally {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
