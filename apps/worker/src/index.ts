import "dotenv/config";
import {
  createAdminClient,
  type HealthState,
  sleepInterruptible,
  startHealthServer,
} from "@peptidefi/shared";
import { runOnce } from "./run";

/**
 * CLI entry. Two modes:
 *   pnpm dev / pnpm start  — loop forever, sleeping WORKER_CYCLE_INTERVAL_MS
 *                            between cycles (default 60s).
 *   pnpm once / --once     — single cycle, exit. Manual testing path.
 *
 * Health endpoint: HTTP GET /health on HEALTH_PORT (default 8080) returns a
 * JSON snapshot of cycle state. Healthy iff the last cycle finished within
 * 2× the cycle interval. Railway uses this for deploy checks.
 *
 * Graceful shutdown: SIGTERM/SIGINT abort the inter-cycle sleep, let the
 * in-flight cycle finish, close the health server, and exit 0. We never
 * leave a peptide_twaps row half-written.
 */

const intervalMs = Number.parseInt(
  process.env.WORKER_CYCLE_INTERVAL_MS ?? "60000",
  10,
);

const healthPort = Number.parseInt(process.env.HEALTH_PORT ?? "8080", 10);

const runOnceFlag = process.argv.includes("--once");

const startedAt = new Date().toISOString();
const health: HealthState = {
  service: "worker",
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

/**
 * Startup sanity check: warn if the worker cadence + freshness ceiling
 * combination is set up to produce thin-data rows between scrapes.
 *
 * Misconfig pattern: worker runs every 60s, scraper runs every 10 min,
 * worker considers only the last 5 min of obs → most worker cycles fall
 * between scrapes and find nothing → wave of NULL TWAPs.
 *
 * The check needs both env vars in this process. On a single-host deploy
 * (sandbox, dev) both are typically present. On Railway with separate
 * services, set SCRAPER_CYCLE_INTERVAL_MS in the worker service too so
 * this check works.
 */
function checkConfig(): void {
  const scraperRaw = process.env.SCRAPER_CYCLE_INTERVAL_MS;
  if (!scraperRaw) return;
  const scraperInterval = Number.parseInt(scraperRaw, 10);
  if (!Number.isFinite(scraperInterval) || scraperInterval <= 0) return;
  const freshness = Number.parseInt(
    process.env.WORKER_FRESHNESS_CEILING_MS ??
      process.env.WORKER_TWAP_WINDOW_MS ??
      String(30 * 60 * 1000),
    10,
  );
  if (intervalMs < scraperInterval && freshness < scraperInterval) {
    console.warn(
      `[startup] WARN: worker window may be narrower than scrape cadence; expect thin-data rows between scrapes ` +
        `(WORKER_CYCLE_INTERVAL_MS=${intervalMs}, SCRAPER_CYCLE_INTERVAL_MS=${scraperInterval}, ` +
        `WORKER_FRESHNESS_CEILING_MS=${freshness})`,
    );
  }
}

function fmtSummary(s: Awaited<ReturnType<typeof runOnce>>): string {
  return [
    `processed=${s.peptidesProcessed}`,
    `with_twap=${s.peptidesWithTwap}`,
    `thin=${s.peptidesWithThinData}`,
    `inserted=${s.rowsInserted}`,
    `skipped_idempotent=${s.rowsSkippedIdempotent}`,
    `${s.durationMs}ms`,
  ].join(" ");
}

/**
 * Predictions auto-flagger. Calls public.flag_markets_ready_for_resolution()
 * which closes any market past its closes_at and (for 'auto' markets) drops
 * a suggestion row for admin review. Never resolves on its own.
 *
 * Cadence: at most once every PREDICTIONS_FLAG_INTERVAL_MS (default 30 min);
 * the per-cycle gate uses a timestamp so it doesn't matter how often the
 * TWAP loop ticks underneath.
 */
const flagIntervalMs = Number.parseInt(
  process.env.PREDICTIONS_FLAG_INTERVAL_MS ?? String(30 * 60 * 1000),
  10,
);
let lastFlagAt = 0;

async function maybeFlagPredictions(): Promise<void> {
  const now = Date.now();
  if (now - lastFlagAt < flagIntervalMs) return;
  lastFlagAt = now;
  try {
    const supabase = createAdminClient() as unknown as {
      rpc: (name: string) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
    const { data, error } = await supabase.rpc("flag_markets_ready_for_resolution");
    if (error) {
      console.error(`[predictions-flag] FAILED ${error.message}`);
      return;
    }
    const flagged = (data as { flagged_count?: number } | null)?.flagged_count ?? 0;
    if (flagged > 0) {
      console.log(`[predictions-flag] flagged_count=${flagged}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[predictions-flag] FAILED ${msg}`);
  }
}

async function safeCycle(): Promise<void> {
  health.last_cycle_started_at = new Date().toISOString();
  try {
    const summary = await runOnce();
    console.log(`[twap] ${fmtSummary(summary)}`);
    health.cycles_completed += 1;
    health.last_cycle_status =
      summary.peptidesWithThinData === summary.peptidesProcessed
        ? "all_thin"
        : "ok";
    health.last_cycle_duration_ms = summary.durationMs;
    health.extra = {
      peptides_processed: summary.peptidesProcessed,
      peptides_with_twap: summary.peptidesWithTwap,
      peptides_with_thin_data: summary.peptidesWithThinData,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[twap] FAILED ${msg}`);
    health.cycles_failed += 1;
    health.last_cycle_status = "failed";
  } finally {
    health.last_cycle_finished_at = new Date().toISOString();
  }
}

async function main(): Promise<void> {
  checkConfig();

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
      `[startup] worker looping on ${intervalMs}ms interval (--once for a single cycle)`,
    );
    while (!stopRequested) {
      await safeCycle();
      // Predictions cron piggy-backs on the worker loop. Self-rate-limited
      // to flagIntervalMs so it doesn't fire on every TWAP cycle.
      await maybeFlagPredictions();
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
