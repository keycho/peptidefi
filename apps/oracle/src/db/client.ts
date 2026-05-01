import postgres, { type Sql } from "postgres";

/**
 * Postgres connection factory for the oracle service.
 *
 * The oracle uses the `postgres` npm package directly (rather than
 * supabase-js) for two reasons:
 *
 *   1. Persistent connections for advisory locks (§3.8.1). The
 *      pg_try_advisory_lock acquired at startup must hold for the
 *      lifetime of the process; supabase-js / PostgREST is request-
 *      scoped and would release it between calls.
 *   2. Real transactions for the commit-cycle write. The
 *      register_commit_cycle PG function gives us atomicity at the
 *      DB layer, and the postgres library lets us call it cleanly.
 *
 * Connection URL must be the SESSION-mode endpoint (port 5432), NOT
 * the pooler (port 6543) — pooled connections are transaction-scoped
 * and would also drop our advisory lock between statements.
 */

export type SqlClient = Sql<{}>;

export interface CreateClientOptions {
  /** postgres:// URL with credentials embedded. From ORACLE_DATABASE_URL. */
  databaseUrl: string;
  /**
   * Maximum connections in the pool. Default 5. The advisory-lock
   * connection is reserved separately via sql.reserve(); the pool
   * handles the rest of our queries.
   */
  maxConnections?: number;
  /** Idle connection timeout in seconds. Default 60s. */
  idleTimeoutSec?: number;
}

export function createSqlClient(opts: CreateClientOptions): SqlClient {
  return postgres(opts.databaseUrl, {
    max: opts.maxConnections ?? 5,
    idle_timeout: opts.idleTimeoutSec ?? 60,
    // Cast every Postgres numeric to JS string so caller code never
    // accidentally float-truncates a price. Critical for the canonical
    // Observation form per §02.5 (decimals as strings, never numbers).
    types: {
      // 1700 = numeric / decimal type oid
      bigint: postgres.BigInt,
    },
    // Don't transform column names; we use snake_case across the schema
    // and want to read the same names client-side.
    transform: { undefined: null },
  });
}
