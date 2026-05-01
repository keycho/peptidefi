import "dotenv/config";
import { sleepInterruptible } from "@peptide-oracle/shared";
import { loadConfig, type OracleConfig } from "./config";
import {
  buildInitialState,
  startHealthServer,
  type OracleHealthState,
} from "./health";
import { createSqlClient, type SqlClient } from "./db/client";
import { acquireOracleLock, type AdvisoryLockHandle } from "./advisory-lock";
import { runCyclePoller } from "./pollers/cycle-poller";

/**
 * peptide-oracle on-chain commit service — entry point.
 *
 * Phase B build: the cycle poller now does real work — detect →
 * fetch → adapt → tree → memo → write to commit_cycles +
 * commit_observations atomically (status='pending'). NO Solana
 * submission yet; that's Phase C.
 *
 * Remaining ticket sequence:
 *
 *   - Phase C: Solana commit submission + finalization polling
 *   - TWAP poller (still heartbeat-only)
 *   - long-tail retry job
 *
 * What this file does:
 *
 *   1. Load + validate config (refuses to start on misconfig — §03.5.2).
 *   2. Open a Postgres pool + acquire the §03.8.1 single-instance
 *      advisory lock; refuse to start if another instance holds it.
 *   3. Stand up the /health endpoint with the §03.9.2 required-field
 *      shape, served from a mutable in-memory state object.
 *   4. Run the real cycle poller (Phase B) and a heartbeat-only TWAP
 *      poller concurrently.
 *   5. Honor SIGTERM / SIGINT — abort the inter-cycle sleep, let any
 *      in-flight cycle finish writing, release the advisory lock,
 *      close the pool + health server, exit 0.
 *
 * Deliberately NOT here yet (per ticket scope):
 *
 *   - @solana/web3.js Keypair construction or any RPC call. Phase C.
 *   - Balance check at startup (§03.5.2). Phase C.
 *   - TWAP commit logic. Later ticket.
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

// ─── TWAP heartbeat (placeholder — lands in a later ticket) ────────────

async function twapPollerHeartbeat(): Promise<void> {
  console.log(
    `[startup] twap poller heartbeat-only ` +
      `(interval=${config.poll.twapIntervalMs}ms; TWAP commit logic lands after cycle ticket)`,
  );
  let tick = 0;
  while (!stopRequested) {
    tick += 1;
    // Placeholder for: at HH:00:30 UTC, for each is_active=true peptide,
    // commit the latest peptide_twaps row. See §03.3.
    console.log(`[twap] heartbeat tick=${tick}`);
    if (stopRequested) break;
    await sleepInterruptible(config.poll.twapIntervalMs, shutdownAbort.signal);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    `[startup] oracle service starting ` +
      `(node=${process.version} env=${config.nodeEnv})`,
  );
  console.log(`[startup] oracle wallet: ${config.solanaPublicKey}`);
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
  console.warn(
    `[startup] WARN: Phase B build — cycle poller writes commit_cycles rows ` +
      `at status='pending' but does NOT submit to Solana. Phase C adds submission.`,
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

  const healthServer = startHealthServer({
    port: config.healthPort,
    state: () => health,
    liveness: {
      startedAt,
      warmupMs: config.health.warmupMs,
      staleThresholdMs: config.health.staleThresholdMs,
    },
  });

  try {
    // Run both pollers concurrently. Promise.allSettled rather than
    // Promise.all so one loop crashing doesn't take down the other —
    // the whole-process exit happens through stopRequested + shutdown.
    await Promise.allSettled([
      runCyclePoller({
        sql,
        pollIntervalMs: config.poll.cycleIntervalMs,
        abortSignal: shutdownAbort.signal,
        health,
      }),
      twapPollerHeartbeat(),
    ]);
    console.log("[shutdown] both pollers exited; closing health server");
  } finally {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    // Release the advisory lock before the pool closes — the lock
    // lives on a reserved connection from the pool, so it has to
    // come first.
    await lock.release();
    await sql.end({ timeout: 5 });
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

// `startedAtIso` is referenced by future tickets when the
// snapshot includes startup metadata; export for clarity.
export { startedAtIso };
