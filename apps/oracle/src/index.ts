import "dotenv/config";
import { loadConfig, type OracleConfig } from "./config";
import {
  buildInitialState,
  startHealthServer,
  type OracleHealthState,
} from "./health";
import { createSqlClient, type SqlClient } from "./db/client";
import { acquireOracleLock, type AdvisoryLockHandle } from "./advisory-lock";
import { initAnomalyLog, logAnomaly } from "@peptide-oracle/shared";
import { runCyclePoller } from "./pollers/cycle-poller";
import { runLongTailPoller } from "./pollers/long-tail-poller";
import { runTwapPoller } from "./pollers/twap-poller";
import {
  createIndexComputer,
  loadIndexBaselines,
  type IndexComputer,
} from "./index-computer";
import { runStartupRecovery } from "./index-history-runner";
import { IndexAccountWriter } from "./solana/index-account-writer";
import { IndexLzEmitter } from "./lz/index-lz-emitter";
import { OracleSolanaClient } from "./solana/client";
import { loadOracleKeypair } from "./solana/keypair";
import { PegPusher } from "./peg/peg-pusher";
import { Connection, PublicKey } from "@solana/web3.js";

/**
 * peptide-oracle on-chain commit service — entry point.
 *
 * Phase D build: both pollers now drive their full lifecycles —
 * cycle commits (every ~30s detect, hourly cadence determined by
 * the worker) and TWAP commits (per-peptide, hourly at HH:00:30 UTC
 * per §3.3). Both feed the same Solana submission machinery and
 * obey the same retry/finalization rules. The long-tail retry
 * poller picks up rows whose in-flight retry budget was exhausted
 * (§3.7.7) — currently scoped to commit_cycles only; a follow-up
 * extends it to twap_commits if needed.
 *
 * What this file does:
 *
 *   1. Load + validate config (refuses to start on misconfig — §03.5.2).
 *   2. Open the Postgres pool + acquire the §03.8.1 single-instance
 *      advisory lock; refuse to start if another instance holds it.
 *   3. Construct the Solana RPC client and the signing keypair.
 *      Verify the wallet has at least ORACLE_MIN_STARTUP_BALANCE_SOL
 *      (§03.5.2) — refuse to start if not.
 *   4. Stand up the /health endpoint with the §03.9.2 required-field
 *      shape, served from a mutable in-memory state object.
 *   5. Run cycle poller, TWAP poller, and long-tail retry poller
 *      concurrently. All three share the same Solana client and SQL
 *      pool; the advisory lock guarantees single-instance for the
 *      whole process.
 *   6. Honor SIGTERM / SIGINT — abort the inter-cycle sleep, let any
 *      in-flight cycle finish writing, release the advisory lock,
 *      close the pool + health server, exit 0.
 */

let config: OracleConfig;
try {
  config = loadConfig();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
}

const startedAt = new Date();
const startedAtIso = startedAt.toISOString();

// Mutable health state. The poller tickets will update fields as commits
// land; for now everything stays at its initial placeholder.
const health: OracleHealthState = buildInitialState({
  publicKey: config.solanaPublicKey,
  rpcLabel: rpcLabelFromUrl(config.rpcUrl),
  startedAt,
  cluster: config.solanaCluster,
  pegPusher: {
    enabled: config.pegPusher.enabled,
    peptides: [...config.pegPusher.peptideCodes].sort(),
  },
});

// ─── Shutdown wiring ───────────────────────────────────────────────────

const shutdownAbort = new AbortController();
let stopRequested = false;
function requestShutdown(signal: string): void {
  if (stopRequested) return;
  stopRequested = true;
  console.log(`\n[shutdown] ${signal} received — finishing current cycle, then exiting`);
  shutdownAbort.abort();
}
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    `[startup] oracle service starting ` +
      `(node=${process.version} env=${config.nodeEnv})`,
  );
  console.log(`[startup] oracle wallet: ${config.solanaPublicKey}`);

  // Initialise the append-only anomaly log before anything that
  // might fire an event (advisory lock acquisition runs first below
  // and may emit peg_pusher_lock_stuck on retry).
  initAnomalyLog({
    url: config.supabaseUrl,
    key: config.supabaseSecretKey,
    service: "oracle",
  });
  // Fire a startup event — gives ops a "yes the logger is wired
  // and reaching Supabase" signal on every fresh deploy without
  // having to wait for an organic event.
  void logAnomaly({
    severity: "info",
    eventType: "oracle_started",
    description: `oracle process started (cluster=${config.solanaCluster})`,
    context: {
      cluster: config.solanaCluster,
      node_env: config.nodeEnv,
      node_version: process.version,
      peg_pusher_enabled: config.pegPusher.enabled,
    },
  });
  console.log(
    `[startup] rpc=${rpcLabelFromUrl(config.rpcUrl)} ` +
      `supabase=${new URL(config.supabaseUrl).host}`,
  );
  console.log(
    `[startup] balance thresholds: warn<${config.balance.warnSol} SOL ` +
      `critical<${config.balance.criticalSol} SOL ` +
      `min-startup<${config.balance.minStartupSol} SOL`,
  );
  console.log(`[startup] health endpoint on :${config.healthPort}/health`);

  // Construct the Solana RPC client + signing keypair.
  const solana = new OracleSolanaClient({
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
  });
  const payer = loadOracleKeypair(config.solanaSecretKey);

  // §03.5.2 startup balance gate. Refuses to start if the wallet
  // can't afford a single transaction.
  let startupBalanceLamports: number;
  try {
    startupBalanceLamports = await solana.getBalanceLamports(
      payer.publicKey.toBase58(),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fatal] balance check failed at startup: ${msg}`);
    process.exit(1);
  }
  const startupSol = startupBalanceLamports / 1e9;
  health.wallet.balance_sol = startupSol.toFixed(6);
  if (startupSol < config.balance.minStartupSol) {
    console.error(
      `[fatal] balance ${startupSol} SOL < min-startup ${config.balance.minStartupSol} SOL — refusing to start (§03.5.2)`,
    );
    process.exit(1);
  }
  console.log(
    `[startup] wallet balance: ${startupSol.toFixed(6)} SOL ` +
      `(>= ${config.balance.minStartupSol} SOL min)`,
  );

  // Open the Postgres pool. The advisory-lock acquisition uses a
  // reserved connection out of this pool; the rest of the queries
  // share the remaining slots.
  const sql: SqlClient = createSqlClient({ databaseUrl: config.databaseUrl });

  // Single-instance enforcement (§03.8.1). Refuses to start if another
  // oracle process is already running against the same database.
  let lock: AdvisoryLockHandle;
  try {
    lock = await acquireOracleLock(sql);
    console.log("[startup] advisory lock acquired (single-instance enforced)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fatal] ${msg}`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }

  // BioHash Peptide Index (schema 1.1): load the v1 cohort from
  // public.index_baselines ONCE and freeze it into an IndexComputer
  // for the lifetime of this process. The cohort is identity, not
  // a runtime knob -- see loadIndexBaselines's lifecycle comment
  // for the restart-required semantics if an operator ever mutates
  // index_baselines while the oracle is running. The runner stays
  // null only when the table is empty (pre-launch), in which case
  // the existing first-pin path continues to function and emits
  // schema 1.1 manifests with index_snapshot=null.
  let indexComputer: IndexComputer | null = null;
  let baselinesLoaded = false;
  try {
    const baselines = await loadIndexBaselines(sql);
    if (baselines.length === 0) {
      console.warn(
        "[startup] index_baselines is empty; BioHash Peptide Index disabled. " +
          "Run apps/oracle/scripts/compute-baseline-twaps.ts --apply to " +
          "populate the table and restart.",
      );
    } else {
      indexComputer = createIndexComputer(baselines);
      baselinesLoaded = true;
      health.index.cohort_size = indexComputer.cohortSize();
      console.log(
        `[startup] index cohort loaded: N=${indexComputer.cohortSize()} ` +
          `(peptides=${indexComputer.cohortPeptideCodes().slice(0, 4).join(",")}...)`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[startup] loadIndexBaselines failed; index disabled (non-fatal): ${msg}`,
    );
  }

  // Construct the peg pusher (or null when disabled). Uses its own
  // Connection — same RPC URL + same keypair as the cycle/TWAP
  // pollers, but the AnchorProvider underneath wants a web3.js
  // Connection directly rather than the OracleSolanaClient wrapper.
  let pegPusher: PegPusher | null = null;
  if (config.pegPusher.enabled) {
    if (!config.pegPusher.programId) {
      // parsePegPusherConfig already enforces this, but the type
      // narrowing here gives the rest of the function a non-null id.
      console.error("[fatal] pegPusher.enabled=true but programId missing");
      process.exit(1);
    }
    const pegConn = new Connection(config.rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: config.confirmation.timeoutMs,
    });
    pegPusher = new PegPusher(pegConn, payer, {
      programId: new PublicKey(config.pegPusher.programId),
      enabled: true,
      peptideCodes: config.pegPusher.peptideCodes,
      priorityFeeMicroLamports: config.pegPusher.priorityFeeMicroLamports,
      maxRetries: config.pegPusher.maxRetries,
    });
    console.log(
      `[startup] peg pusher enabled program=${config.pegPusher.programId} ` +
        `peptides=[${[...config.pegPusher.peptideCodes].sort().join(",")}] ` +
        `priority_fee=${config.pegPusher.priorityFeeMicroLamports} ` +
        `max_retries=${config.pegPusher.maxRetries}`,
    );
  } else {
    console.log("[startup] peg pusher disabled");
  }

  // Construct the index account writer (schema 1.1 on-chain account).
  // Null when ORACLE_INDEX_PROGRAM_ID is unset — the oracle continues
  // to write DB + IPFS unchanged. Reuses the same Connection + keypair
  // as the peg pusher; the writer wraps them in its own AnchorProvider.
  let indexAccountWriter: IndexAccountWriter | null = null;
  if (config.indexAccount.programId) {
    try {
      const indexConn = new Connection(config.rpcUrl, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: config.confirmation.timeoutMs,
      });
      indexAccountWriter = new IndexAccountWriter(indexConn, payer, {
        programId: new PublicKey(config.indexAccount.programId),
      });
      console.log(
        `[startup] index account writer enabled ` +
          `program=${config.indexAccount.programId} ` +
          `pda=${indexAccountWriter.indexPda.toBase58()}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[startup] ORACLE_INDEX_PROGRAM_ID set but writer construction failed ` +
          `(non-fatal, on-chain write disabled): ${msg}`,
      );
      indexAccountWriter = null;
    }
  } else {
    console.log("[startup] index account writer disabled (ORACLE_INDEX_PROGRAM_ID unset)");
  }

  // Construct the LayerZero emitter for the Base mirror. Same gating
  // pattern as the on-chain index account writer: null disables the
  // subsystem entirely; the oracle continues to write Solana index PDA
  // and DB + IPFS unchanged. The emitter reuses the same Connection +
  // keypair as the index writer; it wraps them in its own AnchorProvider.
  let lzEmitter: IndexLzEmitter | null = null;
  if (
    config.lzEmitter.programId &&
    config.lzEmitter.endpointProgramId &&
    config.lzEmitter.dstEid
  ) {
    try {
      const lzConn = new Connection(config.rpcUrl, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: config.confirmation.timeoutMs,
      });
      lzEmitter = new IndexLzEmitter(lzConn, payer, {
        programId: new PublicKey(config.lzEmitter.programId),
        endpointProgramId: new PublicKey(config.lzEmitter.endpointProgramId),
        dstEid: config.lzEmitter.dstEid,
        maxFeeLamports: BigInt(config.lzEmitter.maxFeeLamports),
      });
      console.log(
        `[startup] lz emitter enabled ` +
          `program=${config.lzEmitter.programId} ` +
          `dst_eid=${config.lzEmitter.dstEid} ` +
          `oapp=${lzEmitter.oappStore.toBase58()} ` +
          `peer=${lzEmitter.peer.toBase58()} ` +
          `max_fee_lamports=${config.lzEmitter.maxFeeLamports}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[startup] ORACLE_LZ_EMITTER_PROGRAM_ID set but emitter construction ` +
          `failed (non-fatal, lz emit disabled): ${msg}`,
      );
      lzEmitter = null;
    }
  } else {
    console.log("[startup] lz emitter disabled (ORACLE_LZ_EMITTER_PROGRAM_ID unset)");
  }

  // Startup recovery runs to completion BEFORE the pollers begin
  // ticking. Closes two gap classes deterministically: Case D (oracle
  // killed mid-INSERT into index_history) and Case C (oracle killed
  // mid-repin-loop with ipfs_cids still null). Both are idempotent
  // under the same ON CONFLICT and IS NULL guards the in-process
  // trigger uses, so a clean shutdown leaves nothing to recover and
  // this completes near-instantly. Runs AFTER the on-chain writer is
  // constructed so backlogged hours also push to the index account.
  if (baselinesLoaded && indexComputer) {
    try {
      await runStartupRecovery(sql, indexComputer, health.index, indexAccountWriter, lzEmitter);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[startup] runStartupRecovery failed (non-fatal, continuing): ${msg}`,
      );
    }
  }

  const healthServer = startHealthServer({
    port: config.healthPort,
    state: () => snapshotWithPegMetrics(health, pegPusher),
    liveness: {
      startedAt,
      warmupMs: config.health.warmupMs,
      staleThresholdMs: config.health.staleThresholdMs,
    },
  });

  const minBalanceLamports = Math.floor(
    config.balance.minStartupSol * 1e9,
  );

  try {
    // Run all pollers concurrently. Promise.allSettled rather than
    // Promise.all so one loop crashing doesn't take down the others —
    // the whole-process exit happens through stopRequested + shutdown.
    await Promise.allSettled([
      runCyclePoller({
        sql,
        pollIntervalMs: config.poll.cycleIntervalMs,
        abortSignal: shutdownAbort.signal,
        health,
        solana,
        payer,
        minBalanceLamports,
        confirmationTimeoutMs: config.confirmation.timeoutMs,
        cluster: config.solanaCluster,
      }),
      runLongTailPoller({
        sql,
        intervalMs: config.retry.longTailIntervalMs,
        abortSignal: shutdownAbort.signal,
        maxTotalRetries: config.retry.maxTotalRetries,
      }),
      runTwapPoller({
        sql,
        tickIntervalMs: config.poll.twapIntervalMs,
        abortSignal: shutdownAbort.signal,
        health,
        solana,
        payer,
        minBalanceLamports,
        confirmationTimeoutMs: config.confirmation.timeoutMs,
        cluster: config.solanaCluster,
        pegPusher,
        indexComputer,
        indexAccountWriter,
        lzEmitter,
      }),
    ]);
    console.log("[shutdown] all pollers exited");
  } finally {
    // Shutdown sequence — each step independently fault-tolerant so a
    // crash in one doesn't prevent the others. Order matters:
    //
    //   1. Release the advisory lock (sends pg_advisory_unlock + frees
    //      the reserved connection). Done BEFORE sql.end so the unlock
    //      query lands on a still-open connection.
    //   2. Close the postgres pool with a 5s drain timeout — gives any
    //      setImmediate-queued writes from the lock-release path time
    //      to flush before the underlying sockets are torn down. (The
    //      previous shutdown order — health server first, then lock,
    //      then sql.end — was crashing in postgres@3.4.9 with
    //      "Cannot read properties of null (reading 'write')" at
    //      connection.js:255, a queued write firing post-close.)
    //   3. Close the health server LAST. Railway has already removed
    //      the service from the load balancer once SIGTERM fired, so
    //      keeping /health responsive through the DB cleanup phase is
    //      harmless; if anything it makes diagnosing slow shutdowns
    //      easier.
    //
    // Each step is wrapped in its own try/catch so a thrown error
    // logs + flows through to the next step rather than aborting the
    // shutdown halfway. A clean exit is more important than perfect
    // cleanup at this point.
    try {
      await lock.release();
      console.log("[shutdown] advisory lock released");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[shutdown] lock release failed: ${msg}`);
    }
    try {
      await sql.end({ timeout: 5 });
      console.log("[shutdown] postgres pool closed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[shutdown] sql.end failed: ${msg}`);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        healthServer.close((err) => (err ? reject(err) : resolve()));
      });
      console.log("[shutdown] health server closed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[shutdown] health server close failed: ${msg}`);
    }
    console.log("[shutdown] clean exit");
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Best-effort label for the RPC. Helius URLs include the API key as a
 * query param, which we don't want in logs or in /health. Strip the
 * query string for display.
 */
function rpcLabelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host.includes("helius") ? "helius" : u.host;
  } catch {
    return "unknown";
  }
}

/**
 * Pull-model integration: each /health request takes a fresh
 * snapshot of the pusher's 24h rolling counters and merges them
 * into the health state. Avoids the pusher having to write back
 * into the mutable health object on every push (which would
 * couple two modules' shutdown order to each other).
 */
function snapshotWithPegMetrics(
  base: OracleHealthState,
  pusher: PegPusher | null,
): OracleHealthState {
  if (!pusher) return base;
  const m = pusher.metrics();
  return {
    ...base,
    peg_pusher: {
      ...base.peg_pusher,
      last_push_at: m.last_push_at,
      last_push_peptide: m.last_push_peptide,
      last_push_signature: m.last_push_signature,
      push_count_24h: m.push_count_24h,
      failed_count_24h: m.failed_count_24h,
      skipped_count_24h: m.skipped_count_24h,
      last_check_attempt_at: m.last_check_attempt_at,
      last_check_peptide: m.last_check_peptide,
      last_skip_reason: m.last_skip_reason,
      last_skip_at: m.last_skip_at,
      last_skip_peptide: m.last_skip_peptide,
      last_failure_at: m.last_failure_at,
      last_failure_message: m.last_failure_message,
      last_failure_peptide: m.last_failure_peptide,
    },
  };
}

// `startedAtIso` is referenced by future tickets when the
// snapshot includes startup metadata; export for clarity.
export { startedAtIso };
