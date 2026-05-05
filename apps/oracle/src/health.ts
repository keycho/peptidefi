import { createServer, type Server } from "node:http";

/**
 * /health endpoint for the oracle service.
 *
 * Implements the §03.9.2 normative-required-field contract verbatim. The
 * shape is fixed; monitoring (Better Stack per §08.9.1, plus any
 * downstream consumers) depends on these field names. Adding extras is
 * fine; removing or renaming any required field is a breaking change to
 * the operational contract.
 *
 * Health rule (§03.9.2):
 *
 *   ok = HTTP 200 iff
 *     wallet.balance_critical == false
 *     AND cycle.last_commit_at within ORACLE_HEALTH_STALE_THRESHOLD_MS
 *     AND twap.last_commit_at within 3 × that threshold (TWAP cadence
 *         is hourly; one missed slot tolerated)
 *     AND cycle.failed_count_24h < 5
 *     AND twap.failed_count_24h < 5
 *
 * Warm-up window: during the first ORACLE_HEALTH_WARMUP_MS after process
 * start, the staleness checks for last_commit_at fields are skipped.
 * Lets a fresh deploy come up healthy before the first commit lands.
 *
 * This file is the SCAFFOLD version — the state object exposes the
 * full required shape but every "live" field is stubbed (nulls + zeros)
 * until the cycle and TWAP poller tickets fill them in.
 */

// ─── Public state shape ────────────────────────────────────────────────

/**
 * The state object the health server reads from. The poller tickets
 * (cycle / TWAP / balance check) update fields on this object;
 * /health serializes a snapshot per request.
 *
 * Mutable on purpose — we want lock-free reads from the http handler.
 * Updates are single-writer in v1 (no concurrent pollers race on the
 * same field; the cycle poller only writes cycle.*, etc.).
 */
export interface OracleHealthState {
  service: "oracle";
  started_at: string;
  ok: boolean;
  /** Cluster the oracle is currently committing to. Helps ops verify which side of a devnet→mainnet cutover is live. */
  cluster: "devnet" | "mainnet-beta" | "testnet";

  wallet: {
    public_key: string;
    balance_sol: string;
    balance_low: boolean;
    balance_critical: boolean;
  };

  cycle: {
    last_commit_at: string | null;
    last_committed_cycle_id: number | null;
    in_flight_count: number;
    failed_count_24h: number;
  };

  twap: {
    last_commit_at: string | null;
    last_hour_committed_count: number;
    last_hour_skipped_count: number;
    in_flight_count: number;
    failed_count_24h: number;
  };

  rpc: {
    primary: string;
    last_error_at: string | null;
    last_error_class: string | null;
    blockhash_age_seconds: number;
  };
}

// ─── Builders ──────────────────────────────────────────────────────────

/**
 * Build the initial state from config. Values that won't be known until
 * the first poll cycle (last_commit_at, balance_sol, etc.) start at
 * placeholder defaults that the §03.9.2 contract permits (null for
 * timestamps, "0.000000" for the balance string).
 */
export function buildInitialState(args: {
  publicKey: string;
  rpcLabel: string;
  startedAt: Date;
  cluster: "devnet" | "mainnet-beta" | "testnet";
}): OracleHealthState {
  return {
    service: "oracle",
    started_at: args.startedAt.toISOString(),
    ok: true, // healthy during warm-up; first poll cycle may flip this
    cluster: args.cluster,

    wallet: {
      public_key: args.publicKey,
      balance_sol: "0.000000",
      balance_low: false,
      balance_critical: false,
    },

    cycle: {
      last_commit_at: null,
      last_committed_cycle_id: null,
      in_flight_count: 0,
      failed_count_24h: 0,
    },

    twap: {
      last_commit_at: null,
      last_hour_committed_count: 0,
      last_hour_skipped_count: 0,
      in_flight_count: 0,
      failed_count_24h: 0,
    },

    rpc: {
      primary: args.rpcLabel,
      last_error_at: null,
      last_error_class: null,
      blockhash_age_seconds: 0,
    },
  };
}

// ─── Liveness rule ─────────────────────────────────────────────────────

export interface LivenessOptions {
  startedAt: Date;
  warmupMs: number;
  staleThresholdMs: number;
  /** TWAP staleness budget = staleThresholdMs × this. Default 3. */
  twapStalenessMultiplier?: number;
  /** Failure-count threshold beyond which /health flips to 503. Default 5. */
  failedCountThreshold?: number;
}

export function isHealthy(
  state: OracleHealthState,
  opts: LivenessOptions,
): boolean {
  // Critical balance always trumps freshness — a wallet that can't sign
  // is unhealthy regardless of when the last commit was.
  if (state.wallet.balance_critical) return false;

  if (state.cycle.failed_count_24h >= (opts.failedCountThreshold ?? 5)) return false;
  if (state.twap.failed_count_24h >= (opts.failedCountThreshold ?? 5)) return false;

  const now = Date.now();
  const inWarmup = now - opts.startedAt.getTime() < opts.warmupMs;

  // Skip staleness checks during warm-up so a fresh deploy isn't
  // immediately reported unhealthy before the first commit lands.
  if (inWarmup) return true;

  if (!state.cycle.last_commit_at) return false;
  const cycleStaleMs = now - Date.parse(state.cycle.last_commit_at);
  if (cycleStaleMs > opts.staleThresholdMs) return false;

  if (!state.twap.last_commit_at) return false;
  const twapStaleMs = now - Date.parse(state.twap.last_commit_at);
  const twapBudget = opts.staleThresholdMs * (opts.twapStalenessMultiplier ?? 3);
  if (twapStaleMs > twapBudget) return false;

  return true;
}

// ─── HTTP server ───────────────────────────────────────────────────────

export interface HealthServerOptions {
  port: number;
  /** Snapshot getter — called per request. */
  state: () => OracleHealthState;
  liveness: LivenessOptions;
}

export function startHealthServer(opts: HealthServerOptions): Server {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/health" && req.url !== "/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
      return;
    }
    const snapshot = opts.state();
    const ok = isHealthy(snapshot, opts.liveness);
    // Mutate ok on the snapshot so the wire response is internally
    // consistent (the upstream state.ok is a hint; the liveness rule
    // is authoritative).
    const body = JSON.stringify({ ...snapshot, ok });
    res.writeHead(ok ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(body);
  });

  server.listen(opts.port, "0.0.0.0");

  server.on("error", (err) => {
    console.error(`[health] server error: ${err.message}`);
  });

  return server;
}
