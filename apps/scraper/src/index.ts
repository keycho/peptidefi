import "dotenv/config";
import { runOnce } from "./run";

/**
 * CLI entry. Two modes:
 *   pnpm dev             — loop forever, sleeping SCRAPER_CYCLE_INTERVAL_MS
 *                           between cycles (default 60s). Used in dev and
 *                           on Railway.
 *   pnpm once / --once   — run a single cycle and exit. Used for manual
 *                           testing, debugging, and from scripts.
 *
 * Cycle interval env var: SCRAPER_CYCLE_INTERVAL_MS is the canonical name.
 * SCRAPE_INTERVAL_MS is kept as a back-compat fallback for the .env files
 * we wrote earlier in this branch. Default 60000.
 *
 * Set SCRAPER_CYCLE_INTERVAL_MS=600000 (10 min) during ScrapingAnt
 * free-tier soak to stretch the 10k credit pool across ~7 days at 6
 * credits/cycle.
 *
 * Graceful shutdown: SIGINT / SIGTERM flip a flag that prevents the next
 * cycle from starting. The current in-flight cycle finishes naturally so
 * we never leave a scraper_runs row stuck in 'running'.
 */
const intervalMs = Number.parseInt(
  process.env.SCRAPER_CYCLE_INTERVAL_MS ??
    process.env.SCRAPE_INTERVAL_MS ??
    "60000",
  10,
);

const runOnceFlag = process.argv.includes("--once");

let stopRequested = false;
process.on("SIGINT", () => {
  console.log("\n[shutdown] SIGINT received — finishing current cycle, then exiting");
  stopRequested = true;
});
process.on("SIGTERM", () => {
  console.log("\n[shutdown] SIGTERM received — finishing current cycle, then exiting");
  stopRequested = true;
});

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
  try {
    const summary = await runOnce();
    console.log(`[cycle] ${fmtSummary(summary)}`);
  } catch (err) {
    // runOnce traps all per-product errors. A throw here means an
    // infrastructure failure (Supabase unreachable, env missing, etc.).
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[cycle] FAILED ${msg}`);
  }
}

async function main(): Promise<void> {
  if (runOnceFlag) {
    await safeCycle();
    return;
  }

  console.log(
    `[startup] scraper running on ${intervalMs}ms interval (--once to run a single cycle)`,
  );

  // Run once immediately, then loop.
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
