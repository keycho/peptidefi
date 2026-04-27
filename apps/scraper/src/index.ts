import "dotenv/config";
import { runOnce } from "./run";

/**
 * CLI entry. Two modes:
 *   pnpm dev             — loop forever, sleeping SCRAPE_INTERVAL_MS between
 *                           cycles (default 60s). Used in dev and on Railway.
 *   pnpm once / --once   — run a single cycle and exit. Used for manual
 *                           testing, debugging, and from scripts.
 *
 * Graceful shutdown: SIGINT / SIGTERM flip a flag that prevents the next
 * cycle from starting. The current in-flight cycle finishes naturally so
 * we never leave a scraper_runs row stuck in 'running'.
 */
const intervalMs = Number.parseInt(
  process.env.SCRAPE_INTERVAL_MS ?? "60000",
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
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the process alive solely for the timer.
    t.unref?.();
  });
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
