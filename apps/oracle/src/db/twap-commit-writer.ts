import type { SqlClient } from "./client";

/**
 * Insert a 'pending' twap_commits row. Idempotent on
 * (peptide_code, computed_at) per the unique index in migration
 * 0031.
 *
 * If a row already exists for that composite key (re-run after
 * crash, or two pollers racing — though §3.8.1 prevents the
 * latter), the INSERT is a no-op and we return the existing row's
 * UUID + status. The caller can use that to skip the rest of the
 * lifecycle for an already-finalized row, or continue submission
 * for a 'pending' one.
 *
 * No PG function needed here: it's a single-statement insert, so
 * atomicity is trivial. Contrast with register_commit_cycle (which
 * spans cycle row + N junction rows) — TWAP commits don't have a
 * junction table.
 */

export interface RegisterTwapCommitArgs {
  peptide_code: string;
  twap_value: string;
  computed_at: Date;
  window_start: Date;
  window_end: Date;
  /** "0x" + 64 hex from buildTwapCommit. */
  observation_set_root: string;
  /** Canonical UTF-8 memo body from buildTwapCommit. */
  memo_payload: string;
  /**
   * Solana cluster the row is being committed to. Stamped on
   * twap_commits.cluster (added in migration 0033) so historical rows
   * remain identifiable across the devnet → mainnet cutover.
   */
  cluster: "devnet" | "mainnet-beta" | "testnet";
}

export interface RegisteredTwapCommit {
  id: string;
  /** True if a new row was inserted; false if the (peptide_code, computed_at) was already present. */
  inserted: boolean;
  /** The current status of the row (existing or newly-inserted). */
  status: "pending" | "submitted" | "finalized" | "failed";
}

export async function registerTwapCommit(
  sql: SqlClient,
  args: RegisterTwapCommitArgs,
): Promise<RegisteredTwapCommit> {
  // Upsert pattern: try the insert; on conflict return the existing
  // row instead. The CTE chain returns whichever wins.
  const rows = await sql<
    {
      id: string;
      status: "pending" | "submitted" | "finalized" | "failed";
      inserted: boolean;
    }[]
  >`
    WITH ins AS (
      INSERT INTO public.twap_commits (
        peptide_code,
        twap_value,
        computed_at,
        window_start,
        window_end,
        observation_set_root,
        memo_payload,
        cluster
      ) VALUES (
        ${args.peptide_code},
        ${args.twap_value}::numeric,
        ${args.computed_at},
        ${args.window_start},
        ${args.window_end},
        ${args.observation_set_root},
        ${args.memo_payload},
        ${args.cluster}
      )
      ON CONFLICT (peptide_code, computed_at) DO NOTHING
      RETURNING id, status::text AS status
    )
    SELECT id, status, true AS inserted FROM ins
    UNION ALL
    SELECT id, status::text AS status, false AS inserted
    FROM   public.twap_commits
    WHERE  peptide_code = ${args.peptide_code}
      AND  computed_at  = ${args.computed_at}
      AND  NOT EXISTS (SELECT 1 FROM ins)
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(
      `registerTwapCommit: neither insert nor select returned a row for ` +
        `(${args.peptide_code}, ${args.computed_at.toISOString()})`,
    );
  }
  return {
    id: row.id,
    inserted: row.inserted,
    status: row.status,
  };
}
