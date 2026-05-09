import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Append-only operational log helper.
 *
 * Writes to the `public.anomalies` table (see migration 0034). The
 * table's RLS contract is "service_role insert, public read, no
 * update/delete"; this module uses a service-role Supabase client.
 *
 * Critical invariants this module guarantees:
 *
 *   1. Never throws. Caller can `await logAnomaly(...)` without
 *      try/catch. A network failure, RLS rejection, or schema drift
 *      logs to console and returns `null` — the caller gets nothing
 *      it can break on.
 *
 *   2. Never blocks the pipeline. Inserts go through the supabase-js
 *      client with an explicit per-call timeout (default 5s). A
 *      hung Supabase doesn't stall the oracle's TWAP/cycle commits;
 *      a slow log is preferable to a missing one, but a missing
 *      log is preferable to a stalled commit.
 *
 *   3. Singleton init. The first call to `initAnomalyLog(...)` wires
 *      the underlying client; subsequent calls are no-ops. Callers
 *      that haven't seen `initAnomalyLog` (e.g. during a unit-test
 *      run that doesn't bother) hit a fast-path that logs to
 *      console and returns null — same behaviour as a transient
 *      Supabase failure, no surprise.
 *
 * Usage pattern:
 *
 *   // At process startup (apps/oracle/src/index.ts):
 *   initAnomalyLog({ url, key, service: "oracle" });
 *
 *   // At a notable event:
 *   const stuck = await logAnomaly({
 *     severity: "error",
 *     eventType: "peg_pusher_lock_stuck",
 *     description: "advisory lock held > 60s",
 *     context: { attempt, elapsedMs },
 *   });
 *
 *   // Later, when the lock releases:
 *   await logAnomaly({
 *     severity: "info",
 *     eventType: "peg_pusher_lock_released",
 *     description: "lock acquired after retries",
 *     resolvedBy: stuck?.id,
 *   });
 */

export type Severity = "info" | "warn" | "error" | "critical";

export interface AnomalyParams {
  severity: Severity;
  eventType: string;
  description: string;
  vendorId?: string;
  peptideId?: string;
  observationId?: number;
  cycleId?: number;
  context?: Record<string, unknown>;
  /**
   * If set, the new row's `resolved_at` is populated with `now()` and
   * `resolved_by` references the prior anomaly row. Used to mark a
   * prior 'stuck' / 'failed' / 'offline' event as resolved by this
   * follow-up.
   */
  resolvedBy?: number;
}

export interface InitOptions {
  url: string;
  key: string;
  /** Service name stamped on the `x-peptide-oracle-service` header for tracing. */
  service: string;
  /** Per-insert timeout in ms. Default 5_000. */
  insertTimeoutMs?: number;
}

interface LoggerState {
  client: SupabaseClient;
  insertTimeoutMs: number;
}

let state: LoggerState | null = null;

/**
 * Initialise the logger with a service-role Supabase client. Safe to
 * call multiple times — only the first call wires the client; later
 * calls are no-ops (so a stray re-init from a hot reload doesn't
 * leak connections).
 */
export function initAnomalyLog(options: InitOptions): void {
  if (state) return;
  const client = createClient(options.url, options.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { "x-peptide-oracle-service": options.service },
    },
  });
  state = {
    client,
    insertTimeoutMs: options.insertTimeoutMs ?? 5_000,
  };
}

/**
 * Reset state. Test-only — do not call from production code paths.
 */
export function _resetForTests(): void {
  state = null;
}

/**
 * Insert one anomaly row. See module-level invariants. Returns the
 * inserted row's id on success, or null if anything went wrong
 * (network, schema mismatch, timeout, logger uninitialised, etc.).
 */
export async function logAnomaly(
  params: AnomalyParams,
): Promise<{ id: number } | null> {
  if (!state) {
    // Uninitialised — log to console so the event isn't lost, return
    // null. Guards both unit tests and accidental import-before-init
    // ordering bugs.
    console.warn(
      `[anomalyLog] not initialised; falling back to console: ` +
        `${params.severity} ${params.eventType} ${params.description}`,
    );
    return null;
  }
  const { client, insertTimeoutMs } = state;

  const row = {
    severity: params.severity,
    event_type: params.eventType,
    description: params.description,
    vendor_id: params.vendorId ?? null,
    peptide_id: params.peptideId ?? null,
    observation_id: params.observationId ?? null,
    cycle_id: params.cycleId ?? null,
    context: params.context ?? null,
    resolved_by: params.resolvedBy ?? null,
    // resolved_at populated server-side iff resolved_by is set: a
    // follow-up event marks the original as resolved at insert time.
    resolved_at: params.resolvedBy != null ? new Date().toISOString() : null,
  };

  // Race the insert against a timer so a hung Supabase backend
  // doesn't block the caller. The supabase-js builder doesn't
  // support AbortSignal directly; a Promise.race is the cleanest
  // surface.
  const insertPromise = client
    .from("anomalies")
    .insert(row)
    .select("id")
    .single();

  let result;
  try {
    result = await Promise.race([
      insertPromise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`anomalyLog insert timeout (${insertTimeoutMs}ms)`)),
          insertTimeoutMs,
        );
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[anomalyLog] insert threw (${params.eventType}): ${msg}`,
    );
    return null;
  }

  if (result.error) {
    console.error(
      `[anomalyLog] insert failed (${params.eventType}): ${result.error.message}`,
    );
    return null;
  }

  // Return the new row's id so the caller can set `resolvedBy` on a
  // follow-up event.
  const id = (result.data as { id?: number } | null)?.id;
  return typeof id === "number" ? { id } : null;
}
