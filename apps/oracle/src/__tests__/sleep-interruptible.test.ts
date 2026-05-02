import { describe, expect, it } from "vitest";
import { sleepInterruptible } from "@peptide-oracle/shared";

/**
 * Regression coverage for the listener-leak bug that surfaced in
 * production with:
 *
 *   MaxListenersExceededWarning: Possible EventTarget memory leak
 *   detected. 11 abort listeners added to [AbortSignal].
 *
 * Cause: the earlier sleepInterruptible used
 * `signal.addEventListener("abort", h, { once: true })` — the
 * `once` flag auto-removes the listener only on the abort path. On
 * the normal-completion path (timer fires before SIGTERM), the
 * listener was orphaned. Three pollers ticking on a shared
 * shutdownAbort.signal exhausted the default MaxListeners=10
 * within ~5 minutes of operation.
 *
 * The fix: removeEventListener explicitly when the timer fires.
 *
 * These tests assert listener count returns to 0 in BOTH paths so
 * a future regression that re-introduces the leak goes red here
 * before it ships.
 */

describe("sleepInterruptible — listener cleanup", () => {
  it("removes the abort listener on timer-fire path (normal completion)", async () => {
    const ac = new AbortController();
    const before = countAbortListeners(ac.signal);
    expect(before).toBe(0);

    await sleepInterruptible(5, ac.signal);

    expect(countAbortListeners(ac.signal)).toBe(0);
  });

  it("removes the abort listener on abort-fire path", async () => {
    const ac = new AbortController();
    const sleep = sleepInterruptible(60_000, ac.signal);
    // Listener attached.
    expect(countAbortListeners(ac.signal)).toBe(1);
    ac.abort();
    await sleep;
    expect(countAbortListeners(ac.signal)).toBe(0);
  });

  it("does not add a listener when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await sleepInterruptible(60_000, ac.signal);
    expect(countAbortListeners(ac.signal)).toBe(0);
  });

  it("does not leak listeners across many sequential sleeps", async () => {
    const ac = new AbortController();
    for (let i = 0; i < 30; i++) {
      await sleepInterruptible(1, ac.signal);
    }
    // 30 sequential sleeps would have leaked 30 listeners with the
    // old code; the new code must keep this at 0.
    expect(countAbortListeners(ac.signal)).toBe(0);
  });
});

/**
 * Count the number of "abort" event listeners on an AbortSignal.
 *
 * Node's AbortSignal extends EventTarget; EventTarget exposes an
 * undocumented but stable getEventListeners interface in tests via
 * the `Symbol.for("nodejs.util.inspect.custom")` shape, but the
 * supported API is `events.getEventListeners` from node:events
 * (since Node 15).
 */
function countAbortListeners(signal: AbortSignal): number {
  // events.getEventListeners works for any EventTarget on Node 15+.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getEventListeners } = require("node:events") as {
    getEventListeners: (target: EventTarget, type: string) => unknown[];
  };
  return getEventListeners(signal, "abort").length;
}
