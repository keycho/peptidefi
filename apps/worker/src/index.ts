import "dotenv/config";
import { runOnce } from "./run";

/**
 * CLI entry. Two modes:
 *   pnpm dev / pnpm start  — loop forever, sleeping WORKER_CYCLE_INTERVAL_MS
 *                            between cycles (default 60s).
 *   pnpm once / --once     — single cycle, exit. Manual testing path.
 *
 * Graceful shutdown: SIGINT / SIGTERM flip a flag that prevents the next
 * cycle. The current in-flight cycle finishes naturally so we never leave
 * a peptide_twaps row half-written.
 */

const intervalMs = Number.parseInt(
  process.env.WORKER_CYCLE_INTERVAL_MS ?? "60000",
  10,
);

const runOnceFlag = process.argv.includes("--once");

/**
 * Startup sanity check: warn if the worker cadence + freshness ceiling
 * combination is set up to produce thin-data rows between scrapes.
 *
 * Misconfig pattern: worker runs every 60s, scraper runs every 10 min,
 * worker considers only the last 5 min of obs. Most worker cycles fall
 * between scrapes and find nothing → wave of NULL TWAPs. The 03:39 UTC
 * incident this commit fixes was exactly this.
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

let stopRequested = false;
process.on("SIGINT", () => {
  console.log("\n[shutdown] SIGINT — finishing cycle, exiting");
  stopRequested = true;
});
process.on("SIGTERM", () => {
  console.log("\n[shutdown] SIGTERM — finishing cycle, exiting");
  stopRequested = true;
});

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

async function safeCycle(): Promise<void> {
  try {
    const summary = await runOnce();
    console.log(`[twap] ${fmtSummary(summary)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[twap] FAILED ${msg}`);
  }
}

async function main(): Promise<void> {
  checkConfig();

  if (runOnceFlag) {
    await safeCycle();
    return;
  }

  console.log(
    `[startup] worker running on ${intervalMs}ms interval (--once to run a single cycle)`,
  );

  while (!stopRequested) {
    await safeCycle();
    if (stopRequested) break;
    await sleep(intervalMs);
  }
  console.log("[shutdown] clean exit");
}

function sleep(ms: number): Promise<void> {
  // Do NOT unref() the timer — it IS the loop. Without a TTY (Docker /
  // Railway / background processes) there's nothing else holding the event
  // loop open, so unref'ing here causes Node to exit between cycles.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
