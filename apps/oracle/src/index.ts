import "dotenv/config";
import { loadConfig, type OracleConfig } from "./config";
import {
  buildInitialState,
  startHealthServer,
  type OracleHealthState,
} from "./health";
import { createSqlClient, type SqlClient } from "./db/client";
import { acquireOracleLock, type AdvisoryLockHandle } from "./advisory-lock";
import { runCyclePoller } from "./pollers/cycle-poller";
import { runLongTailPoller } from "./pollers/long-tail-poller";
import { runTwapPoller } from "./pollers/twap-poller";
import { OracleSolanaClient } from "./solana/client";
import { loadOracleKeypair } from "./solana/keypair";

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

  const healthServer = startHealthServer({
    port: config.healthPort,
    state: () => health,
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
      }),
    ]);
    console.log("[shutdown] all pollers exited; closing health server");
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
