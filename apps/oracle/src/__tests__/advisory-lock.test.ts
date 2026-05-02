import { describe, expect, it, vi } from "vitest";
import type { ReservedSql, Sql } from "postgres";
import { acquireOracleLock } from "../advisory-lock";

/**
 * Coverage for the §3.8.1 advisory-lock acquisition + the
 * retry-with-backoff added after the §08.5.7 ghost-lock incidents.
 *
 * The retry behavior is the production fix for "Supavisor keeps the
 * previous oracle's backend alive in the pool with the lock still
 * held during a Railway redeploy." We assert:
 *
 *   - succeeds on first try when pg_try_advisory_lock returns true
 *   - retries up to ~12 times (60s budget at 5s interval) when the
 *     lock is initially held, then succeeds when it's released
 *   - hard-fails after the budget is exhausted with a clear error
 *     message that references §08.5.7
 *   - releases the reserved connection on hard-fail (no pool leak)
 *   - explicit release calls pg_advisory_unlock + connection.release()
 *
 * No real DB; we stub the postgres.js Sql client + ReservedSql
 * connection.
 */

interface MockReserved {
  /** queue of values that successive `connection\`SELECT pg_try_advisory_lock…\`` calls return */
  acquireResults: boolean[];
  /** number of times .release() was called */
  releaseCount: number;
  /** captured pg_advisory_unlock invocations */
  unlockCalls: number;
}

function makeMockReserved(state: MockReserved): ReservedSql<{}> {
  // postgres.js's ReservedSql is callable as a tagged template.
  // We dispatch on the SQL text fragment to decide which mock
  // value to return.
  const tag = ((strings: TemplateStringsArray, ..._args: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("pg_try_advisory_lock")) {
      const next = state.acquireResults.shift();
      const acquired = next === undefined ? false : next;
      return Promise.resolve([{ acquired }]);
    }
    if (sql.includes("pg_advisory_unlock")) {
      state.unlockCalls += 1;
      return Promise.resolve([{ released: true }]);
    }
    return Promise.resolve([]);
  }) as unknown as ReservedSql<{}>;
  (tag as unknown as { release: () => Promise<void> }).release = async () => {
    state.releaseCount += 1;
  };
  return tag;
}

function makeMockSql(state: MockReserved): Sql<{}> {
  return {
    reserve: () => Promise.resolve(makeMockReserved(state)),
  } as unknown as Sql<{}>;
}

describe("acquireOracleLock", () => {
  it("succeeds on first attempt when pg_try_advisory_lock returns true", async () => {
    const state: MockReserved = {
      acquireResults: [true],
      releaseCount: 0,
      unlockCalls: 0,
    };
    const sleep = vi.fn(async (_ms: number) => {});
    const handle = await acquireOracleLock(makeMockSql(state), {
      sleepMs: sleep,
    });
    expect(state.releaseCount).toBe(0); // connection still held by lock
    expect(sleep).not.toHaveBeenCalled();
    expect(handle.connection).toBeDefined();

    await handle.release();
    expect(state.unlockCalls).toBe(1);
    expect(state.releaseCount).toBe(1);
  });

  it("retries when the first attempts return false, succeeds when the lock is released", async () => {
    const state: MockReserved = {
      acquireResults: [false, false, true],
      releaseCount: 0,
      unlockCalls: 0,
    };
    const sleep = vi.fn(async (_ms: number) => {});
    const onRetry = vi.fn();
    const handle = await acquireOracleLock(makeMockSql(state), {
      retryIntervalMs: 5_000,
      retryMaxWaitMs: 60_000,
      sleepMs: sleep,
      onRetry,
    });
    expect(handle.connection).toBeDefined();
    // 2 retries between 3 attempts → 2 sleeps → 2 onRetry calls
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1); // attempt index reported
    expect(onRetry.mock.calls[1]?.[0]).toBe(2);
    expect(state.releaseCount).toBe(0); // not released; lock held by handle
  });

  it("hard-fails when the retry budget is exhausted, releasing the reserved connection", async () => {
    // Use small real intervals (50ms / 200ms total) so the test
    // finishes in <1s while exercising the real Date.now-driven
    // budget-exhaustion path.
    const state: MockReserved = {
      acquireResults: Array(20).fill(false),
      releaseCount: 0,
      unlockCalls: 0,
    };
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    await expect(
      acquireOracleLock(makeMockSql(state), {
        retryIntervalMs: 50,
        retryMaxWaitMs: 200,
        sleepMs: sleep,
      }),
    ).rejects.toThrow(/§08\.5\.7|ghost-lock recovery/);
    expect(state.releaseCount).toBe(1);
    expect(state.unlockCalls).toBe(0);
  });

  it("does not overshoot the wall-clock budget on the final wait", async () => {
    // 5 falses with a 7s budget → can do at most 1 retry (5s sleep);
    // 2nd attempt's wait would be capped/skipped.
    const state: MockReserved = {
      acquireResults: [false, false, false, false, false],
      releaseCount: 0,
      unlockCalls: 0,
    };
    let totalSleptMs = 0;
    let elapsedMsClock = 0;
    const sleep = vi.fn(async (ms: number) => {
      totalSleptMs += ms;
      elapsedMsClock += ms;
    });
    // Stub Date.now to advance by the slept time, so the budget math
    // converges deterministically.
    const realNow = Date.now;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      return 1_000_000 + elapsedMsClock;
    });
    try {
      await expect(
        acquireOracleLock(makeMockSql(state), {
          retryIntervalMs: 5_000,
          retryMaxWaitMs: 7_000,
          sleepMs: sleep,
        }),
      ).rejects.toThrow();
      // 1st attempt → false → sleep(min(5000, 7000-0)) = 5000
      // 2nd attempt → false → sleep(min(5000, 7000-5000)) = 2000
      // 3rd attempt → false → remaining = 0 → throw
      expect(totalSleptMs).toBe(7_000);
    } finally {
      dateNowSpy.mockRestore();
      void realNow;
    }
  });

  it("re-throws connection errors immediately (no retry on infrastructure failure)", async () => {
    const tag = ((strings: TemplateStringsArray, ..._args: unknown[]) => {
      void strings;
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as unknown as ReservedSql<{}>;
    let releaseCount = 0;
    (tag as unknown as { release: () => Promise<void> }).release = async () => {
      releaseCount += 1;
    };
    const sql = {
      reserve: () => Promise.resolve(tag),
    } as unknown as Sql<{}>;
    await expect(
      acquireOracleLock(sql, { sleepMs: async () => {} }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(releaseCount).toBe(1);
  });
});
