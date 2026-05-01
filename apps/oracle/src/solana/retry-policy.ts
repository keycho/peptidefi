import type { ErrorClass } from "./errors";

/**
 * Retry/backoff policy per §3.7.1 (in-flight retries) and §3.7.7
 * (long-tail retry after the in-flight budget is exhausted).
 *
 * Budget semantics:
 *
 *   in-flight retries (§3.7.1):
 *     attempt 1: 0       (initial submit)
 *     attempt 2: 30s ± 10s
 *     attempt 3: 2m ± 30s
 *     attempt 4: 10m ± 2m
 *     attempt 5: 30m ± 5m
 *     after 5 attempts: status='failed'
 *
 *   long-tail (§3.7.7) — once status='failed':
 *     1st long-tail: 1h after last failure
 *     2nd long-tail: 4h
 *     3rd onward:   24h
 *     hard cap:     ORACLE_MAX_TOTAL_RETRIES (default 20)
 *
 * Jitter is uniform in the ±range and applied per-call so a wave of
 * failures (say, a Helius outage) doesn't herd all retries onto the
 * same wallclock instant.
 *
 * RPC_RATE_LIMITED gets a 60s initial backoff instead of 30s, per
 * §3.7.2 — the rate-limit window is usually 60s, so retrying inside
 * that window guarantees another rejection.
 */

export const IN_FLIGHT_MAX_RETRIES = 5;

interface BackoffSpec {
  /** Center of the backoff window in ms. */
  centerMs: number;
  /** ± jitter in ms. Total range = centerMs ± jitterMs. */
  jitterMs: number;
}

const IN_FLIGHT_BACKOFF: BackoffSpec[] = [
  { centerMs: 0, jitterMs: 0 }, // attempt 1: no wait
  { centerMs: 30_000, jitterMs: 10_000 },
  { centerMs: 120_000, jitterMs: 30_000 },
  { centerMs: 600_000, jitterMs: 120_000 },
  { centerMs: 1_800_000, jitterMs: 300_000 },
];

const LONG_TAIL_BACKOFF: BackoffSpec[] = [
  { centerMs: 3_600_000, jitterMs: 600_000 }, // 1st: 1h ± 10m
  { centerMs: 14_400_000, jitterMs: 1_800_000 }, // 2nd: 4h ± 30m
  // 3rd onwards: 24h ± 1h. Replicated as a single entry — the
  // policy clamps the index to len-1.
  { centerMs: 86_400_000, jitterMs: 3_600_000 },
];

export interface InFlightBackoffResult {
  /** Wait this many ms before the next submission attempt. */
  waitMs: number;
  /** True if the retry-count budget should advance for this class. */
  countAgainstBudget: boolean;
  /** True if the next attempt is the last one before status='failed'. */
  isLastAttempt: boolean;
}

/**
 * Compute the wait + budget effect for the next in-flight retry.
 *
 *   priorRetryCount = the value already in commit_cycles.retry_count
 *                     (== number of completed attempts before this one)
 *
 * Returns { waitMs, countAgainstBudget } and a flag for "this is
 * the last attempt before exhaustion."
 */
export function nextInFlightBackoff(
  priorRetryCount: number,
  errorClass: ErrorClass,
): InFlightBackoffResult {
  if (errorClass === "BLOCKHASH_EXPIRED" || errorClass === "SIGNATURE_ALREADY_EXISTS") {
    // Reconciliation paths — no budget burn, retry immediately.
    return { waitMs: 0, countAgainstBudget: false, isLastAttempt: false };
  }

  // Index = priorRetryCount: how many attempts we've already made.
  //   priorRetryCount=0 → about to attempt 1 → wait IN_FLIGHT_BACKOFF[0] = 0
  //   priorRetryCount=1 → about to attempt 2 → wait IN_FLIGHT_BACKOFF[1] = 30s
  //   ...
  //   priorRetryCount=4 → about to attempt 5 → wait IN_FLIGHT_BACKOFF[4] = 30m
  //   priorRetryCount>=5 → budget exhausted, status='failed'
  if (priorRetryCount >= IN_FLIGHT_MAX_RETRIES) {
    return {
      waitMs: 0,
      countAgainstBudget: true,
      isLastAttempt: true,
    };
  }

  const spec = IN_FLIGHT_BACKOFF[priorRetryCount]!;
  let waitMs = applyJitter(spec);

  // RPC_RATE_LIMITED bumps the initial backoff to 60s (§3.7.2). The
  // ±10s window matches the standard jitter shape.
  if (errorClass === "RPC_RATE_LIMITED" && waitMs < 60_000) {
    waitMs = 60_000 + (Math.random() * 2 - 1) * 10_000;
  }

  return {
    waitMs: Math.max(0, Math.round(waitMs)),
    countAgainstBudget: true,
    isLastAttempt: priorRetryCount === IN_FLIGHT_MAX_RETRIES - 1,
  };
}

/**
 * Long-tail backoff per §3.7.7: how long after the last failure
 * should we re-attempt a status='failed' row?
 *
 *   priorLongTailRetries = total retry_count - IN_FLIGHT_MAX_RETRIES,
 *                          clamped at 0
 *
 * Returns the wait window in ms.
 */
export function longTailBackoffMs(priorLongTailRetries: number): number {
  const idx = Math.min(priorLongTailRetries, LONG_TAIL_BACKOFF.length - 1);
  const spec = LONG_TAIL_BACKOFF[idx]!;
  return Math.max(0, Math.round(applyJitter(spec)));
}

function applyJitter(spec: BackoffSpec): number {
  if (spec.jitterMs === 0) return spec.centerMs;
  const offset = (Math.random() * 2 - 1) * spec.jitterMs;
  return spec.centerMs + offset;
}
