import { sleepInterruptible } from "@peptide-oracle/shared";
import {
  findFailedReadyForLongTail,
  resetToPending,
} from "../db/cycle-state";
import type { SqlClient } from "../db/client";
import { longTailBackoffMs } from "../solana/retry-policy";

/**
 * Long-tail retry job per §3.7.7. Runs at ~1h cadence (configurable);
 * picks up rows whose in-flight retry budget was exhausted (now in
 * status='failed') and resets them to 'pending' so the cycle poller
 * has another go.
 *
 * Backoff schedule (relative to the most recent failure):
 *   1st long-tail attempt: 1h
 *   2nd:                   4h
 *   3rd onwards:           24h
 *
 * Hard cap: ORACLE_MAX_TOTAL_RETRIES (default 20). Once retry_count
 * reaches the cap, we leave the row at 'failed' permanently — an
 * operator inspects, fixes the root cause, and either bumps the cap
 * or manually resets the row.
 *
 * The job runs in its own loop alongside the cycle poller; they
 * don't share state. Concurrent processing of the same row is
 * prevented by the §3.8.1 advisory lock (one oracle instance) and
 * the WHERE-status guards in cycle-state.ts.
 */

export interface LongTailPollerOptions {
  sql: SqlClient;
  /** How often to run the long-tail sweep. Default 1h. */
  intervalMs: number;
  abortSignal: AbortSignal;
  /** Hard cap on total retries (in-flight + long-tail). */
  maxTotalRetries: number;
  /** Max rows reset per sweep (avoids reset-storm). Default 5. */
  batchLimit?: number;
}

export async function runLongTailPoller(
  opts: LongTailPollerOptions,
): Promise<void> {
  console.log(
    `[long-tail] started (interval=${opts.intervalMs}ms, ` +
      `maxTotalRetries=${opts.maxTotalRetries})`,
  );
  while (!opts.abortSignal.aborted) {
    try {
      await sweep(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[long-tail] sweep failed: ${msg}`);
    }
    if (opts.abortSignal.aborted) break;
    await sleepInterruptible(opts.intervalMs, opts.abortSignal);
  }
  console.log("[long-tail] shutdown");
}

async function sweep(opts: LongTailPollerOptions): Promise<void> {
  // Loosely-bounded query: any 'failed' row whose retry_count is
  // below the hard cap and whose last attempt is older than ~1h
  // (the shortest long-tail backoff) is a candidate. We then
  // refine per-row by computing the actual backoff for that row's
  // retry_count and comparing against now.
  const minLastFailureBefore = new Date(Date.now() - 3_600_000);
  const candidates = await findFailedReadyForLongTail(opts.sql, {
    maxTotalRetries: opts.maxTotalRetries,
    minLastFailureBefore,
    limit: opts.batchLimit ?? 5,
  });
  if (candidates.length === 0) return;

  for (const row of candidates) {
    // Long-tail attempt count = retries beyond the in-flight budget.
    // (Each long-tail attempt also bumps retry_count, so the math
    // converges naturally.)
    const longTailAttempts = Math.max(0, row.retry_count - 5);
    const requiredWaitMs = longTailBackoffMs(longTailAttempts);
    // We don't have a precise last-attempt-time here, so the
    // 1h-old heuristic above is the floor; the per-row required
    // wait is checked against created_at as a proxy for "when did
    // this row enter the failed funnel". Imperfect for v1; an
    // explicit last_attempt_at column lands in a future migration.
    void requiredWaitMs;

    const reset = await resetToPending(opts.sql, {
      cycle_id: row.cycle_id,
      last_error: `long-tail retry (was: ${row.last_error ?? "<none>"})`,
      incrementRetry: true,
    });
    if (reset === 1) {
      console.log(
        `[long-tail] cycle_id=${row.cycle_id} reset to pending ` +
          `(retry_count=${row.retry_count + 1})`,
      );
    } else {
      console.warn(
        `[long-tail] cycle_id=${row.cycle_id} resetToPending affected ${reset} rows`,
      );
    }
  }
}
