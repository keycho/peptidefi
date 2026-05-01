import type { SqlClient } from "./client";
import { bytesToHex0x, type MerkleTree } from "../merkle";

/**
 * Atomic commit-cycle row write via the register_commit_cycle RPC
 * (migration 0032).
 *
 * Why an RPC and not two client-side INSERTs: see header of
 * 0032_commit_cycle_rpc.sql. Short version: PG functions are
 * transactional by default, so the cycle row + all junction rows
 * land atomically.
 *
 * Row state after this call: commit_cycles row exists with
 * status='pending' (the default). Phase C transitions to 'submitted'
 * and 'finalized' as the Solana submission progresses.
 */

export interface RegisterCommitCycleArgs {
  cycle_id: number;
  started_at: Date;
  completed_at: Date;
  observation_count: number;
  /** 0x + 64 lowercase hex from buildMerkleTree(). */
  merkle_root: string;
  /** Canonical JSON memo body from buildCycleMemo(). */
  memo_payload: string;
  /**
   * One entry per leaf, in tree position order. observation_id is the
   * supplier_observations.id; leaf_hash is the 0x+64-hex form of the
   * leaf hash; leaf_index matches the leaf's position in the tree
   * (== position in this array, == ordered-by-id position).
   */
  leaves: Array<{
    observation_id: number;
    leaf_hash: string;
    leaf_index: number;
  }>;
}

/**
 * Build the leaves[] array for register_commit_cycle from a built
 * Merkle tree + the source observations (ordered the same way).
 *
 * Convenience helper — keeps the cycle-poller orchestration code
 * narrow.
 */
export function leavesForCommit(
  observationIds: number[],
  tree: MerkleTree,
): RegisterCommitCycleArgs["leaves"] {
  if (observationIds.length !== tree.leaves.length) {
    throw new Error(
      `commit-writer: observationIds length (${observationIds.length}) ` +
        `!= tree.leaves length (${tree.leaves.length})`,
    );
  }
  return observationIds.map((observation_id, leaf_index) => ({
    observation_id,
    leaf_hash: bytesToHex0x(tree.leaves[leaf_index]!),
    leaf_index,
  }));
}

/**
 * Call the register_commit_cycle Postgres function. Throws on any
 * server-side validation error (leaf-count mismatch, FK violation,
 * unique-constraint violation if the cycle is already committed).
 *
 * Caller is expected to handle the unique-constraint case at a higher
 * level — it indicates either a concurrency bug or a manual cleanup
 * gap. The committer's poll-then-process-then-write sequence (§3.2.2
 * + §3.7.5) is expected to never hit this case in normal operation.
 */
export async function registerCommitCycle(
  sql: SqlClient,
  args: RegisterCommitCycleArgs,
): Promise<void> {
  // Build the jsonb leaves array. The PG function explodes this via
  // jsonb_array_elements and inserts one row per element.
  const leavesJson = JSON.stringify(args.leaves);

  await sql`
    SELECT public.register_commit_cycle(
      ${args.cycle_id}::bigint,
      ${args.started_at}::timestamptz,
      ${args.completed_at}::timestamptz,
      ${args.observation_count}::integer,
      ${args.merkle_root}::text,
      ${args.memo_payload}::text,
      ${leavesJson}::jsonb
    )
  `;
}
