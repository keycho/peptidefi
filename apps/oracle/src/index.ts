import "dotenv/config";
import { sleepInterruptible } from "@peptide-oracle/shared";
import { loadConfig, type OracleConfig } from "./config";
import {
  buildInitialState,
  startHealthServer,
  type OracleHealthState,
} from "./health";

/**
 * peptide-oracle on-chain commit service — entry point.
 *
 * SCAFFOLD ticket: structure only. The two pollers (cycle + TWAP) are
 * stubbed as heartbeat-only loops that log every cycle but don't yet
 * detect cycles, build memos, or submit transactions. Subsequent
 * tickets fill those in:
 *
 *   - cycle poller / Merkle / memo / submit  → next ticket
 *   - TWAP poller                             → after that
 *   - confirmation polling + DB reconciliation → after that
 *   - long-tail retry job                      → final ticket
 *
 * What this file already does correctly:
 *
 *   1. Load + validate config (refuses to start on misconfig — §03.5.2).
 *   2. Stand up the /health endpoint with the §03.9.2 required-field
 *      shape, served from a mutable in-memory state object.
 *   3. Spawn two concurrent async loops (cycle + TWAP heartbeats) at
 *      the §03.2.1 / §03.3.1 cadences.
 *   4. Honor SIGTERM / SIGINT — abort the inter-cycle sleep, let
 *      in-flight work finish, close the health server, exit 0.
 *      Mirrors the apps/worker shutdown shape.
 *
 * Deliberately NOT here yet (per ticket scope):
 *
 *   - @solana/web3.js Keypair construction or any RPC call. Config
 *     validates the secret key bytes parse, but we don't actually
 *     hand them to web3.js until the next ticket.
 *   - Postgres advisory lock acquisition (§03.8.1). Single-instance
 *     enforcement lives with the cycle poller ticket where it
 *     actually matters.
 *   - Supabase client construction. The dependency is in package.json
 *     so the next ticket doesn't need a fresh install, but no
 *     supabase-js calls happen here yet.
 *   - Balance check at startup (§03.5.2) — needs an RPC call and so
 *     belongs with the keypair / RPC integration.
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

// ─── Heartbeat-only pollers (placeholders for later tickets) ───────────

async function cyclePollerHeartbeat(): Promise<void> {
  console.log(
    `[startup] cycle poller heartbeat-only ` +
      `(interval=${config.poll.cycleIntervalMs}ms; cycle detection lands in next ticket)`,
  );
  let tick = 0;
  while (!stopRequested) {
    tick += 1;
    // Placeholder for: query commit_cycles + scraper_runs, build root,
    // submit Memo tx. See §03.2 / §03.4. For now just log heartbeat.
    console.log(`[cycle] heartbeat tick=${tick} pubkey=${config.solanaPublicKey}`);
    if (stopRequested) break;
    await sleepInterruptible(config.poll.cycleIntervalMs, shutdownAbort.signal);
  }
}

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
    `[startup] WARN: this is the SCAFFOLD build — pollers log heartbeats only. ` +
      `No commits will be submitted to Solana. See ticket sequence in src/index.ts header.`,
  );

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
    await Promise.allSettled([cyclePollerHeartbeat(), twapPollerHeartbeat()]);
    console.log("[shutdown] both pollers exited; closing health server");
  } finally {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
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
