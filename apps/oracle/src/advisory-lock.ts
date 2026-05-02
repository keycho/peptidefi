import type { ReservedSql, Sql } from "postgres";

/**
 * Postgres advisory-lock single-instance enforcement per §3.8.1.
 *
 * Acquires `pg_try_advisory_lock(0xC0117EE5, 0xC0117EE5)` on a
 * reserved connection at startup. The lock is session-scoped — it
 * holds for the lifetime of the connection. We never explicitly
 * release it; when the process exits cleanly, the shutdown path
 * calls `pg_advisory_unlock` and releases the reserved connection;
 * when it crashes, Postgres drops the connection and the lock
 * auto-releases.
 *
 * If a second oracle instance starts while one is already holding
 * the lock, `pg_try_advisory_lock` returns false and we retry per
 * the schedule below before giving up. The retry covers the most
 * common false-positive: a Railway redeploy where the previous
 * oracle process exited ungracefully and Supabase's Supavisor
 * pooler is keeping the previous backend alive in the pool with the
 * advisory lock still held. Supavisor will close idle backends
 * eventually, but on a tight redeploy the new instance starts
 * before that cleanup runs.
 *
 * Retry schedule: 5s between attempts, max ~60s wall-clock total
 * (12 attempts). After that we hard-exit; the operator must
 * follow the §08.5.7 ghost-lock recovery procedure
 * (`pg_terminate_backend` on the holding pid).
 *
 * The keys are split into two int4 values because PG's bigint
 * advisory locks vs (int4, int4) overload have different
 * namespaces — using the (int4, int4) form lets us specify the
 * constants in code without bigint-serialization concerns at the
 * driver layer. The mnemonic: "C0117EE5" = "COLITSEES".
 */

const ORACLE_LOCK_KEY_HI = 0xc0117ee5 | 0; // forces signed-int4 interpretation
const ORACLE_LOCK_KEY_LO = 0xc0117ee5 | 0;

/**
 * Default retry tuning. Sized so a Supavisor cleanup window
 * (typically 1–10s after the previous oracle's TCP disconnect) is
 * comfortably covered. Manual override via the `retry` arg on
 * `acquireOracleLock` for tests.
 */
const DEFAULT_RETRY_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_MAX_WAIT_MS = 60_000;

export interface AdvisoryLockHandle {
  /**
   * The reserved connection holding the lock. Don't call .release()
   * on it during normal operation — that would free the lock and
   * let a second instance start.
   */
  connection: ReservedSql<{}>;
  /**
   * Release the lock + return the connection to the pool. Called
   * from graceful shutdown, AFTER the pollers have stopped.
   */
  release: () => Promise<void>;
}

export interface AcquireOracleLockOptions {
  /** ms between retry attempts. Default 5_000. */
  retryIntervalMs?: number;
  /** Total wall-clock budget across all retries. Default 60_000. */
  retryMaxWaitMs?: number;
  /**
   * Sleep function — injectable so tests can advance time without
   * waiting wall-clock seconds.
   */
  sleepMs?: (ms: number) => Promise<void>;
  /**
   * Callback invoked between retry attempts (after a `false` result
   * but before the next attempt). Used by tests to assert retry
   * progression and by ops tooling to log progress.
   */
  onRetry?: (attempt: number, totalElapsedMs: number) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Try to acquire the oracle's single-instance advisory lock,
 * retrying with a fixed interval if the lock is already held (per
 * the §08.5.7 Supavisor cleanup-window scenario).
 *
 * Returns a handle on the first successful `pg_try_advisory_lock`.
 * Throws if the lock can't be acquired within `retryMaxWaitMs`, or
 * on any other connection-level error. The caller is expected to
 * translate a thrown error into a fatal exit at startup.
 */
export async function acquireOracleLock(
  sql: Sql<{}>,
  options: AcquireOracleLockOptions = {},
): Promise<AdvisoryLockHandle> {
  const intervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const maxWaitMs = options.retryMaxWaitMs ?? DEFAULT_RETRY_MAX_WAIT_MS;
  const sleep = options.sleepMs ?? defaultSleep;

  // Reserve a dedicated connection for the lock. The reserve() call
  // pulls one connection out of the pool and pins it to this caller
  // until release. Lock state lives on this connection; nobody else
  // can touch it.
  const connection = await sql.reserve();

  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    let acquired: boolean;
    try {
      const rows = await connection<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(${ORACLE_LOCK_KEY_HI}, ${ORACLE_LOCK_KEY_LO})
          AS acquired
      `;
      acquired = rows[0]?.acquired === true;
    } catch (err) {
      // Release the reservation before re-throwing so we don't leak
      // the pool slot.
      await connection.release();
      throw err;
    }

    if (acquired) {
      return {
        connection,
        release: async () => {
          try {
            // Explicit release is a courtesy; PG would auto-release
            // on connection drop anyway. Doing it explicitly frees
            // the lock immediately so the next instance restart
            // doesn't have to wait for Supavisor's idle cleanup.
            await connection<{ released: boolean }[]>`
              SELECT pg_advisory_unlock(${ORACLE_LOCK_KEY_HI}, ${ORACLE_LOCK_KEY_LO})
                AS released
            `;
          } catch {
            // Best-effort release; if the connection is already dead
            // the lock is gone anyway.
          }
          await connection.release();
        },
      };
    }

    // pg_try_advisory_lock returned false — another session holds it.
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = maxWaitMs - elapsedMs;
    if (remainingMs <= 0) {
      // Out of retry budget. Hard-fail.
      await connection.release();
      throw new Error(
        `advisory-lock: another oracle instance appears to be running ` +
          `(pg_try_advisory_lock returned false on ${attempt} attempts ` +
          `over ~${Math.round(elapsedMs / 1000)}s). If you're sure no ` +
          `other instance exists, the previous process likely crashed ` +
          `and Supavisor is keeping its idle backend alive with the ` +
          `lock still held. Follow the §08.5.7 ghost-lock recovery ` +
          `procedure: pg_terminate_backend on the holding pid via the ` +
          `Supabase Mgmt API or Dashboard SQL editor.`,
      );
    }

    options.onRetry?.(attempt, elapsedMs);
    // Wait the full interval, but don't overshoot the total budget.
    await sleep(Math.min(intervalMs, remainingMs));
  }
}
