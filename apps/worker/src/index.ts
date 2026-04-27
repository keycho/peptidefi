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
