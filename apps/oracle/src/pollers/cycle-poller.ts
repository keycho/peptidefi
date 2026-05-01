import { sleepInterruptible } from "@peptide-oracle/shared";
import {
  fetchCycleObservations,
  findUnanchoredCycle,
} from "../db/cycle-detection";
import { leavesForCommit, registerCommitCycle } from "../db/commit-writer";
import {
  findNextPending,
  findNextSubmitted,
  markFailed,
  markFinalized,
  markSubmitted,
  resetToPending,
} from "../db/cycle-state";
import type { SqlClient } from "../db/client";
import { buildCycleCommitFromObservations } from "../memo";
import { buildMerkleTree } from "../merkle";
import type { OracleHealthState } from "../health";
import { isFinalized, type OracleSolanaClient } from "../solana/client";
import type { Keypair } from "@solana/web3.js";
import { buildSignedMemoTx } from "../solana/memo-tx";
import { classifyError, type ErrorClass } from "../solana/errors";
import {
  IN_FLIGHT_MAX_RETRIES,
  nextInFlightBackoff,
} from "../solana/retry-policy";

/**
 * Cycle-poller orchestration loop — Phase C scope.
 *
 * Each tick walks three steps in priority order:
 *
 *   1. RECONCILE in-flight ('submitted') rows against Solana. The
 *      §3.7.5 race-safe ordering means a row may be at 'submitted'
 *      but the tx never landed (network drop between the DB write
 *      and the sendTransaction call), or the tx finalized but the
 *      DB write didn't happen. getSignatureStatuses + the §3.7.4
 *      blockhash-expiry check resolves both cases.
 *
 *   2. SUBMIT one 'pending' row to Solana per §3.4. Builds + signs
 *      the memo tx, writes the signature to DB BEFORE sending (so
 *      the DB always knows the in-flight signature), then submits.
 *      Errors are classified per §3.7.2 and either retried in-place
 *      (BLOCKHASH_EXPIRED), terminated (INSUFFICIENT_SOL), or left
 *      for the next tick to reconcile.
 *
 *   3. DETECT new cycles (Phase B path). Reads scraper_runs LEFT
 *      JOIN commit_cycles, builds the merkle tree + memo, INSERTs
 *      a 'pending' commit_cycles row.
 *
 * Loop invariants:
 *   - At most one cycle processed per step per tick (§3.2.1).
 *   - Errors don't kill the poller; caught + logged, loop continues.
 *   - Graceful shutdown aborts the inter-tick sleep immediately so
 *     the process exits cleanly within Railway's ~30s drain window.
 *   - In-flight reconciliation runs first so a previously-submitted
 *     row reaches 'finalized' before we accept new work — keeps
 *     in_flight_count bounded.
 */

export interface CyclePollerOptions {
  sql: SqlClient;
  pollIntervalMs: number;
  abortSignal: AbortSignal;
  /** Mutable state — cycle.* fields are updated as commits land. */
  health: OracleHealthState;
  /** Solana RPC client (Phase C). */
  solana: OracleSolanaClient;
  /** Oracle's signing keypair (Phase C). */
  payer: Keypair;
  /** Refuse to submit if balance falls below this (§3.5.2 / §3.7.3). */
  minBalanceLamports: number;
  /** Confirmation polling timeout (90s default per §3.4.6). */
  confirmationTimeoutMs: number;
}

export async function runCyclePoller(opts: CyclePollerOptions): Promise<void> {
  console.log(
    `[cycle-poller] started (interval=${opts.pollIntervalMs}ms, ` +
      `phase C: full lifecycle pending → submitted → finalized)`,
  );

  while (!opts.abortSignal.aborted) {
    try {
      await tick(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cycle-poller] tick failed: ${msg}`);
    }
    if (opts.abortSignal.aborted) break;
    await sleepInterruptible(opts.pollIntervalMs, opts.abortSignal);
  }

  console.log("[cycle-poller] shutdown");
}

async function tick(opts: CyclePollerOptions): Promise<void> {
  // 1. Reconcile in-flight rows first. A 'submitted' row reaching
  // finality unblocks the in_flight_count metric and makes room for
  // step 2 to start a new submit (per the spec's preference for
  // serial processing).
  await reconcileInFlight(opts);
  if (opts.abortSignal.aborted) return;

  // 2. Submit any 'pending' row. New cycles inserted by step 3 of
  // the previous tick will be picked up here.
  await submitOnePending(opts);
  if (opts.abortSignal.aborted) return;

  // 3. Detect a new cycle (if any) and write a 'pending' commit row.
  await detectAndWriteOne(opts);
}

// ─── Step 1: Reconcile a 'submitted' row ───────────────────────────────

async function reconcileInFlight(opts: CyclePollerOptions): Promise<void> {
  const inFlight = await findNextSubmitted(opts.sql);
  if (!inFlight) return;

  const { cycle_id, solana_signature, submitted_at, retry_count } = inFlight;
  let status;
  try {
    status = await opts.solana.getSignatureStatus(solana_signature);
  } catch (err) {
    const cls = classifyError(err);
    console.warn(
      `[cycle-poller] reconcile cycle_id=${cycle_id} sig=${solana_signature} ` +
        `getSignatureStatus failed (${cls.class}): ${cls.message}`,
    );
    return; // try again next tick
  }

  // (a) Finalized → transition to 'finalized'
  if (isFinalized(status)) {
    const slot = status?.slot ?? 0;
    await markFinalized(opts.sql, {
      cycle_id,
      solana_slot: slot,
      finalized_at: new Date(),
    });
    opts.health.cycle.last_commit_at = new Date().toISOString();
    opts.health.cycle.last_committed_cycle_id = cycle_id;
    opts.health.cycle.in_flight_count = Math.max(
      0,
      opts.health.cycle.in_flight_count - 1,
    );
    console.log(
      `[cycle-poller] cycle_id=${cycle_id} FINALIZED slot=${slot} ` +
        `sig=${solana_signature}`,
    );
    return;
  }

  // (b) Validator returned a tx-level error → reconciliation per §3.7.2
  if (status?.err !== null && status?.err !== undefined) {
    const errMsg = JSON.stringify(status.err);
    console.warn(
      `[cycle-poller] cycle_id=${cycle_id} tx error: ${errMsg}`,
    );
    await handlePostSubmitFailure(opts, {
      cycle_id,
      retry_count,
      lastErrorClass: "INVALID_TRANSACTION",
      lastErrorMessage: `tx_error: ${errMsg}`,
      orphanedSignature: solana_signature,
    });
    return;
  }

  // (c) Status null OR confirmationStatus 'processed'/'confirmed':
  //     decide whether to wait or §3.7.4 reconcile-as-dropped.
  const ageMs = Date.now() - new Date(submitted_at).getTime();
  if (ageMs < opts.confirmationTimeoutMs) {
    // Still inside the 90s confirmation window. Just wait.
    return;
  }

  // Past the window. §3.7.4: one more getSignatureStatuses, then if
  // still not seen, treat as dropped.
  let recheck;
  try {
    recheck = await opts.solana.getSignatureStatus(solana_signature);
  } catch {
    recheck = null;
  }
  if (isFinalized(recheck)) {
    const slot = recheck?.slot ?? 0;
    await markFinalized(opts.sql, {
      cycle_id,
      solana_slot: slot,
      finalized_at: new Date(),
    });
    opts.health.cycle.last_commit_at = new Date().toISOString();
    opts.health.cycle.last_committed_cycle_id = cycle_id;
    opts.health.cycle.in_flight_count = Math.max(
      0,
      opts.health.cycle.in_flight_count - 1,
    );
    console.log(
      `[cycle-poller] cycle_id=${cycle_id} FINALIZED (late) slot=${slot}`,
    );
    return;
  }

  // Past 90s + still not finalized + signature not found in cluster
  // history → blockhash has expired (max 60s validity); treat as dropped.
  console.warn(
    `[cycle-poller] cycle_id=${cycle_id} sig=${solana_signature} dropped ` +
      `(>${opts.confirmationTimeoutMs}ms past submit, status not finalized)`,
  );
  await handlePostSubmitFailure(opts, {
    cycle_id,
    retry_count,
    lastErrorClass: "CONFIRMATION_TIMEOUT",
    lastErrorMessage: `dropped (orphan sig=${solana_signature})`,
    orphanedSignature: solana_signature,
  });
}

// ─── Step 2: Submit a 'pending' row ────────────────────────────────────

async function submitOnePending(opts: CyclePollerOptions): Promise<void> {
  const pending = await findNextPending(opts.sql);
  if (!pending) return;

  // Wait the §3.7.1 backoff window if this row has prior failures.
  // submitted_at is left populated on resetToPending (= last attempt
  // time) — see db/cycle-state.ts header.
  if (pending.retry_count > 0) {
    const wait = nextInFlightBackoff(
      pending.retry_count - 1,
      classifyLastError(pending.last_error),
    );
    // Note: we don't have a precise "last attempt time" if the row
    // was just reset to 'pending' from 'submitted' — we'd need to
    // re-read submitted_at. Skipped here: the 30s tick cadence
    // already provides a soft floor, and for v1 the explicit
    // backoff matters for terminal-class decisions, not for hot
    // retry pacing. Each retry happens at the next tick.
    if (pending.retry_count >= IN_FLIGHT_MAX_RETRIES) {
      console.warn(
        `[cycle-poller] cycle_id=${pending.cycle_id} retry budget ` +
          `exhausted (${pending.retry_count}/${IN_FLIGHT_MAX_RETRIES}); ` +
          `marking failed`,
      );
      await markFailed(opts.sql, {
        cycle_id: pending.cycle_id,
        last_error: pending.last_error ?? "in-flight retry budget exhausted",
        incrementRetry: false,
      });
      return;
    }
    void wait; // wait scheduling is per-tick, see comment above
  }

  // §3.5.2 / §3.7.3 balance gate.
  let balanceLamports: number;
  try {
    balanceLamports = await opts.solana.getBalanceLamports(
      opts.payer.publicKey.toBase58(),
    );
  } catch (err) {
    const cls = classifyError(err);
    console.warn(
      `[cycle-poller] balance check failed (${cls.class}): ${cls.message}; ` +
        `skipping submit this tick`,
    );
    return;
  }
  if (balanceLamports < opts.minBalanceLamports) {
    const sol = balanceLamports / 1e9;
    console.error(
      `[cycle-poller] cycle_id=${pending.cycle_id} INSUFFICIENT_SOL: ` +
        `balance=${sol} SOL < min=${opts.minBalanceLamports / 1e9} SOL; ` +
        `marking failed (§3.7.3)`,
    );
    await markFailed(opts.sql, {
      cycle_id: pending.cycle_id,
      last_error: `INSUFFICIENT_SOL: balance=${sol} SOL`,
      incrementRetry: true,
    });
    return;
  }
  opts.health.wallet.balance_sol = (balanceLamports / 1e9).toFixed(6);

  // Build + sign the tx.
  let blockhash;
  try {
    blockhash = await opts.solana.getLatestBlockhash();
  } catch (err) {
    const cls = classifyError(err);
    console.warn(
      `[cycle-poller] getLatestBlockhash failed (${cls.class}): ${cls.message}`,
    );
    return;
  }

  // Fetch a Helius-provided priority fee estimate; fall back to a
  // capped static value if the call fails.
  let priorityFee: number;
  try {
    // Build a draft (unsigned) tx to feed the fee estimator. The
    // estimator only needs the writable account list + program ids;
    // memo bytes aren't strictly necessary but pass them for honesty.
    const draft = buildSignedMemoTx({
      memo: pending.memo_payload,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      payer: opts.payer,
      priorityFeeMicroLamports: 1000, // ignored; placeholder
      cuLimit: 150_000,
    });
    const draftBase64 = Buffer.from(draft.serialized).toString("base64");
    priorityFee = await opts.solana.getPriorityFeeEstimateMicroLamports(
      draftBase64,
      "High",
    );
  } catch (err) {
    console.warn(
      `[cycle-poller] priority fee estimate failed (${(err as Error).message}); ` +
        `using 1000 µlamports/CU fallback`,
    );
    priorityFee = 1000;
  }
  // Cap per §3.4.4: 50_000 µlamports/CU.
  priorityFee = Math.min(priorityFee, 50_000);

  let signed;
  try {
    signed = buildSignedMemoTx({
      memo: pending.memo_payload,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      payer: opts.payer,
      priorityFeeMicroLamports: priorityFee,
      cuLimit: 150_000,
    });
  } catch (err) {
    const cls = classifyError(err);
    console.error(
      `[cycle-poller] cycle_id=${pending.cycle_id} build/sign failed ` +
        `(${cls.class}): ${cls.message}`,
    );
    await markFailed(opts.sql, {
      cycle_id: pending.cycle_id,
      last_error: `build_failure: ${cls.message}`,
      incrementRetry: true,
    });
    return;
  }

  // §3.7.5: write signature + status='submitted' BEFORE sendTransaction.
  // This way if the network call fails or the process dies between
  // the write and the network response, the next tick's reconcile
  // will see the signature and be able to ask Solana about it.
  const submittedAt = new Date();
  const updated = await markSubmitted(opts.sql, {
    cycle_id: pending.cycle_id,
    signature: signed.signature,
    submitted_at: submittedAt,
  });
  if (updated !== 1) {
    console.warn(
      `[cycle-poller] cycle_id=${pending.cycle_id} markSubmitted ` +
        `affected ${updated} rows (expected 1); skipping send`,
    );
    return;
  }

  // Now actually send to the cluster.
  try {
    await opts.solana.sendRawTransaction(signed.serialized);
    console.log(
      `[cycle-poller] cycle_id=${pending.cycle_id} SUBMITTED ` +
        `sig=${signed.signature} priorityFee=${priorityFee}µlamports/CU`,
    );
    opts.health.cycle.in_flight_count += 1;
    return;
  } catch (err) {
    const cls = classifyError(err);
    console.warn(
      `[cycle-poller] cycle_id=${pending.cycle_id} sendTransaction ` +
        `failed (${cls.class}): ${cls.message}`,
    );

    // BLOCKHASH_EXPIRED → invalidate cache + reset to pending so the
    // next tick re-signs with a fresh blockhash. NOT a budget burn.
    if (cls.class === "BLOCKHASH_EXPIRED") {
      opts.solana.invalidateBlockhash();
      await resetToPending(opts.sql, {
        cycle_id: pending.cycle_id,
        last_error: `BLOCKHASH_EXPIRED at submit: ${cls.message}`,
        incrementRetry: false,
      });
      return;
    }

    if (cls.class === "INSUFFICIENT_SOL") {
      await markFailed(opts.sql, {
        cycle_id: pending.cycle_id,
        last_error: `INSUFFICIENT_SOL at submit: ${cls.message}`,
        incrementRetry: true,
      });
      return;
    }

    if (cls.class === "INVALID_TRANSACTION") {
      await markFailed(opts.sql, {
        cycle_id: pending.cycle_id,
        last_error: `INVALID_TRANSACTION at submit: ${cls.message}`,
        incrementRetry: true,
      });
      return;
    }

    // RPC_TRANSIENT, RPC_RATE_LIMITED, SIGNATURE_ALREADY_EXISTS,
    // UNKNOWN: leave the row at 'submitted' with the signature.
    // The next tick's reconcile loop will check on-chain status —
    // if the tx actually landed despite the error, we'll see it.
    // If it didn't, the §3.7.4 dropped-tx path handles it.
  }
}

// ─── Step 3: Detect + write new cycles (Phase B path) ──────────────────

async function detectAndWriteOne(opts: CyclePollerOptions): Promise<void> {
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
      `[cycle-poller] cycle_id=${cycle.cycle_id} has zero observations; ` +
        `skipping (no-commit per §02.4.5)`,
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

  const elapsed = Date.now() - startMs;
  console.log(
    `[cycle-poller] cycle_id=${cycle.cycle_id} written status=pending ` +
      `elapsed_ms=${elapsed}`,
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface PostSubmitFailureArgs {
  cycle_id: number;
  retry_count: number;
  lastErrorClass: ErrorClass;
  lastErrorMessage: string;
  orphanedSignature: string;
}

async function handlePostSubmitFailure(
  opts: CyclePollerOptions,
  args: PostSubmitFailureArgs,
): Promise<void> {
  const decision = nextInFlightBackoff(args.retry_count, args.lastErrorClass);
  const auditMsg = `${args.lastErrorClass}: ${args.lastErrorMessage} ` +
    `(orphan_sig=${args.orphanedSignature})`;

  // INSUFFICIENT_SOL / INVALID_TRANSACTION are terminal classes.
  if (
    args.lastErrorClass === "INSUFFICIENT_SOL" ||
    args.lastErrorClass === "INVALID_TRANSACTION"
  ) {
    await markFailed(opts.sql, {
      cycle_id: args.cycle_id,
      last_error: auditMsg,
      incrementRetry: true,
    });
    opts.health.cycle.in_flight_count = Math.max(
      0,
      opts.health.cycle.in_flight_count - 1,
    );
    return;
  }

  // Budget exhausted → status='failed'.
  if (decision.isLastAttempt && args.retry_count + 1 >= IN_FLIGHT_MAX_RETRIES) {
    await markFailed(opts.sql, {
      cycle_id: args.cycle_id,
      last_error: auditMsg,
      incrementRetry: true,
    });
    opts.health.cycle.in_flight_count = Math.max(
      0,
      opts.health.cycle.in_flight_count - 1,
    );
    console.warn(
      `[cycle-poller] cycle_id=${args.cycle_id} retry budget exhausted; failed`,
    );
    return;
  }

  // Otherwise reset to 'pending' for the next-tick re-attempt.
  await resetToPending(opts.sql, {
    cycle_id: args.cycle_id,
    last_error: auditMsg,
    incrementRetry: decision.countAgainstBudget,
  });
  opts.health.cycle.in_flight_count = Math.max(
    0,
    opts.health.cycle.in_flight_count - 1,
  );
}

function classifyLastError(lastError: string | null): ErrorClass {
  if (!lastError) return "UNKNOWN";
  // The error string is one we wrote ourselves above; lift the prefix.
  for (const cls of [
    "RPC_TRANSIENT",
    "RPC_RATE_LIMITED",
    "BLOCKHASH_EXPIRED",
    "INSUFFICIENT_SOL",
    "INVALID_TRANSACTION",
    "CONFIRMATION_TIMEOUT",
    "SIGNATURE_ALREADY_EXISTS",
  ] as const) {
    if (lastError.startsWith(cls)) return cls;
  }
  return "UNKNOWN";
}
