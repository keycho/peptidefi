import { sleepInterruptible } from "@peptide-oracle/shared";
import {
  fetchCycleObservations,
  findUnanchoredCycle,
} from "../db/cycle-detection";
import { leavesForCommit, registerCommitCycle } from "../db/commit-writer";
import type { SqlClient } from "../db/client";
import { buildCycleCommitFromObservations } from "../memo";
import { buildMerkleTree } from "../merkle";
import type { OracleHealthState } from "../health";

/**
 * Cycle-poller orchestration loop.
 *
 * Phase B scope (this file): detect → fetch → adapt → tree → memo → write.
 * Result: a commit_cycles row at status='pending' plus one
 * commit_observations row per leaf, all in one transaction. NO Solana
 * submission — that's Phase C.
 *
 * Loop invariants:
 *   - At most one cycle processed per tick (per §3.2.1 — sequential).
 *   - LIMIT 1 in findUnanchoredCycle keeps the queue tight; a backlog
 *     drains one cycle per poll interval.
 *   - Errors on a single cycle don't kill the poller: caught + logged,
 *     loop continues. Re-detection on next poll re-attempts.
 *   - A graceful shutdown signal aborts the inter-cycle sleep
 *     immediately so the process can exit cleanly within Railway's
 *     ~30s drain window.
 */

export interface CyclePollerOptions {
  sql: SqlClient;
  pollIntervalMs: number;
  abortSignal: AbortSignal;
  /** Mutable state — cycle.* fields are updated as commits land. */
  health: OracleHealthState;
}

export async function runCyclePoller(opts: CyclePollerOptions): Promise<void> {
  console.log(
    `[cycle-poller] started (interval=${opts.pollIntervalMs}ms, ` +
      `phase B: write-only, no Solana submission)`,
  );

  while (!opts.abortSignal.aborted) {
    try {
      await processOneCycle(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cycle-poller] tick failed: ${msg}`);
    }
    if (opts.abortSignal.aborted) break;
    await sleepInterruptible(opts.pollIntervalMs, opts.abortSignal);
  }

  console.log("[cycle-poller] shutdown");
}

/**
 * Process one detected cycle end-to-end:
 *   1. Find the next unanchored cycle (or no-op if queue is empty).
 *   2. Fetch its observations in canonical form.
 *   3. Build the Merkle tree + cycle memo.
 *   4. Atomically write commit_cycles + commit_observations via the
 *      register_commit_cycle RPC.
 *   5. Update the in-memory health state.
 *
 * Returns silently if there's no cycle to process. Any thrown error
 * propagates to the loop's catch handler.
 */
async function processOneCycle(opts: CyclePollerOptions): Promise<void> {
  const cycle = await findUnanchoredCycle(opts.sql);
  if (!cycle) return;

  const startMs = Date.now();
  const observations = await fetchCycleObservations(opts.sql, cycle.cycle_id);

  if (observations.length === 0) {
    // Per §02.4.5: don't commit zero-observation cycles. The detection
    // query's EXISTS clause should have prevented this from happening,
    // but defend in depth — fetch could legitimately return 0 if
    // observations were deleted between detection and fetch (rare but
    // possible in test scenarios).
    console.log(
      `[cycle-poller] cycle_id=${cycle.cycle_id} has zero successful ` +
        `observations; skipping (would be a no-commit per §02.4.5)`,
    );
    return;
  }

  // Build the Merkle tree + memo from canonical observations.
  const { memo, rootHex } = buildCycleCommitFromObservations({
    cycle_id: cycle.cycle_id,
    started_at: cycle.started_at.toISOString(),
    completed_at: cycle.completed_at.toISOString(),
    observations,
  });

  // Build the per-leaf entries matching tree.leaves order. Since
  // buildMerkleTree sorts by id ASC and observations are already
  // ordered ASC by the SELECT, the tree's leaf positions correspond
  // 1:1 with the observation order here.
  const tree = buildMerkleTree(observations);
  const leaves = leavesForCommit(
    observations.map((o) => o.id),
    tree,
  );

  console.log(
    `[cycle-poller] cycle_id=${cycle.cycle_id} ` +
      `obs=${observations.length} ` +
      `root=${rootHex} ` +
      `memo_bytes=${Buffer.byteLength(memo, "utf-8")}`,
  );

  await registerCommitCycle(opts.sql, {
    cycle_id: cycle.cycle_id,
    started_at: cycle.started_at,
    completed_at: cycle.completed_at,
    observation_count: observations.length,
    merkle_root: rootHex,
    memo_payload: memo,
    leaves,
  });

  // Update health state. The wire shape's `last_commit_at` is
  // technically meant to mean "last finalized-on-Solana commit"; in
  // Phase B (no Solana yet) we use it to surface "last DB write
  // succeeded" so the /health staleness check still tracks liveness.
  // Phase C will repurpose the field to mean finalization time and
  // introduce a separate "last write" field if the distinction
  // matters operationally.
  opts.health.cycle.last_commit_at = new Date().toISOString();
  opts.health.cycle.last_committed_cycle_id = cycle.cycle_id;
  opts.health.cycle.in_flight_count += 1; // pending; Phase C decrements on finalize

  const elapsed = Date.now() - startMs;
  console.log(
    `[cycle-poller] cycle_id=${cycle.cycle_id} written status=pending ` +
      `elapsed_ms=${elapsed}`,
  );
}
