import { createServer, type Server } from "node:http";

/**
 * Shared health-endpoint helper for the scraper and worker services.
 *
 * Each service maintains its own HealthState struct (started_at, last cycle
 * timestamps + status, cumulative counters) and passes a state-getter to
 * startHealthServer(). The HTTP endpoint /health serialises the current
 * state and returns 200 OK when the service looks alive, or 503 Service
 * Unavailable when the last cycle finished too long ago.
 *
 * Liveness rule:
 *   - First 30 seconds after startup: always healthy (no cycle yet).
 *   - After that: healthy iff last_cycle_finished_at is within
 *     staleAfterMs (typically 2× the cycle interval, so a single missed
 *     cycle doesn't flap us).
 *
 * Railway's deploy health check hits GET /health and waits for 200; a
 * 503 (or no response) within healthcheckTimeout marks the deploy failed
 * and rolls back. The endpoint is deliberately tiny (no JSON parser
 * dependency, no router) so a misconfigured cycle never takes the
 * health endpoint down with it.
 */

export interface HealthState {
  service: string;
  started_at: string;
  cycles_completed: number;
  cycles_failed: number;
  last_cycle_started_at: string | null;
  last_cycle_finished_at: string | null;
  last_cycle_status: string | null;
  last_cycle_duration_ms: number | null;
  /** Service-specific extras (e.g. proxy credit counter). */
  extra?: Record<string, unknown>;
}

export interface HealthOptions {
  port: number;
  state: () => HealthState;
  /**
   * If the last cycle finished longer ago than this, /health returns 503.
   * Pass cycleIntervalMs * 2 for one-missed-cycle tolerance.
   */
  staleAfterMs: number;
}

export function startHealthServer(opts: HealthOptions): Server {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/health" && req.url !== "/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
      return;
    }
    const state = opts.state();
    const ok = isHealthy(state, opts.staleAfterMs);
    const body = JSON.stringify({ ok, ...state });
    res.writeHead(ok ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(body);
  });

  // Bind 0.0.0.0 so Railway's healthcheck inside the container network can reach it.
  server.listen(opts.port, "0.0.0.0");

  // Errors here would otherwise crash the process; log and let the cycle loop
  // survive — health endpoint going down is bad but not fatal.
  server.on("error", (err) => {
    console.error(`[health] server error: ${err.message}`);
  });

  return server;
}

function isHealthy(state: HealthState, staleAfterMs: number): boolean {
  const startedAt = Date.parse(state.started_at);
  if (Number.isFinite(startedAt) && Date.now() - startedAt < 30_000) {
    return true; // grace window during startup before any cycle has run
  }
  if (!state.last_cycle_finished_at) return false;
  const lastFinished = Date.parse(state.last_cycle_finished_at);
  if (!Number.isFinite(lastFinished)) return false;
  return Date.now() - lastFinished < staleAfterMs;
}

/**
 * Sleep helper that resolves early when the abort signal fires. Both
 * services use this between cycles so SIGTERM during a sleep doesn't
 * keep Railway waiting (the scraper's 10-min sleep would otherwise
 * blow past Railway's typical 30s deploy-shutdown grace period).
 */
export function sleepInterruptible(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
