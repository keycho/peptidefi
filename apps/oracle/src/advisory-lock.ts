import type { ReservedSql, Sql } from "postgres";

/**
 * Postgres advisory-lock single-instance enforcement per §3.8.1.
 *
 * Acquires `pg_try_advisory_lock(0xC0117EE5C0117EE5)` on a reserved
 * connection at startup. The lock is session-scoped — it holds for the
 * lifetime of the connection. We never explicitly release it; when the
 * process exits (clean or crash), Postgres drops the connection and
 * the lock auto-releases.
 *
 * If a second oracle instance starts while one is already holding the
 * lock, `pg_try_advisory_lock` returns false and we log fatal + exit 1.
 * This matches the spec's "refuse to start" semantics — Railway runs
 * one instance per service, so this is belt-and-suspenders against a
 * botched redeploy or accidental concurrent run.
 *
 * The constant 0xC0117EE5C0117EE5 is split into two int4 values
 * because PG's bigint advisory locks vs (int4, int4) overload have
 * different namespaces — using the (int4, int4) form lets us specify
 * the constant in code without bigint serialization concerns at the
 * driver layer.
 */

// "C0117EE5C0117EE5" → split into two 32-bit halves: 0xC0117EE5, 0xC0117EE5
// (Both halves are the same; the original constant was chosen for the
// "COLITSEEC OLITSEES" mnemonic.)
const ORACLE_LOCK_KEY_HI = 0xc0117ee5 | 0; // forces signed-int interpretation
const ORACLE_LOCK_KEY_LO = 0xc0117ee5 | 0;

export interface AdvisoryLockHandle {
  /**
   * The reserved connection holding the lock. Don't call .release() on
   * it during normal operation — that would free the lock and let a
   * second instance start.
   */
  connection: ReservedSql<{}>;
  /**
   * Release the lock + return the connection to the pool. Called from
   * graceful shutdown, AFTER the pollers have stopped.
   */
  release: () => Promise<void>;
}

/**
 * Try to acquire the oracle's single-instance advisory lock.
 *
 * Returns a handle on success. Throws on failure (lock already held,
 * connection error, etc.). The caller is expected to translate the
 * error into a fatal exit at startup.
 */
export async function acquireOracleLock(sql: Sql<{}>): Promise<AdvisoryLockHandle> {
  // Reserve a dedicated connection for the lock. The reserve() call
  // pulls one connection out of the pool and pins it to this caller
  // until release. Lock state lives on this connection; nobody else
  // can touch it.
  const connection = await sql.reserve();

  let acquired: boolean;
  try {
    const rows = await connection<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${ORACLE_LOCK_KEY_HI}, ${ORACLE_LOCK_KEY_LO})
        AS acquired
    `;
    acquired = rows[0]?.acquired === true;
  } catch (err) {
    // Release the reservation before re-throwing so we don't leak the
    // pool slot.
    await connection.release();
    throw err;
  }

  if (!acquired) {
    await connection.release();
    throw new Error(
      "advisory-lock: another oracle instance is already running " +
        "(pg_try_advisory_lock returned false). " +
        "If you're sure no other instance exists, the previous process " +
        "may have crashed without releasing — restart Postgres or kill " +
        "the holding session via pg_stat_activity.",
    );
  }

  return {
    connection,
    release: async () => {
      try {
        // Explicit release is a courtesy; PG would auto-release on
        // connection drop anyway. Doing it explicitly speeds up the
        // case where the next instance restarts immediately.
        await connection<{ released: boolean }[]>`
          SELECT pg_advisory_unlock(${ORACLE_LOCK_KEY_HI}, ${ORACLE_LOCK_KEY_LO})
            AS released
        `;
      } catch {
        // Best-effort release; if the connection is already dead the
        // lock is gone anyway.
      }
      await connection.release();
    },
  };
}
