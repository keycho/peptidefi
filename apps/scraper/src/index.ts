import "dotenv/config";
import {
  type HealthState,
  createAdminClientUntyped,
  initAnomalyLog,
  logAnomaly,
  sleepInterruptible,
  startHealthServer,
} from "@peptide-oracle/shared";
import { runOnce } from "./run";
import { getProxyDiagnostics } from "./suppliers/woocommerce";

// Wire the append-only anomaly log before any cycle runs. The
// scraper hits Supabase for observation writes either way; the env
// vars are guaranteed present (createAdminClient throws on missing).
// initAnomalyLog is idempotent so a hot reload doesn't leak clients.
{
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (url && key) {
    initAnomalyLog({ url, key, service: "scraper" });
    // Free signal that the logger is wired and reaching Supabase
    // on every fresh deploy. Mirrors the oracle's startup event.
    void logAnomaly({
      severity: "info",
      eventType: "scraper_started",
      description: "scraper process started",
      context: {
        node_version: process.version,
        cycle_interval_ms: Number.parseInt(
          process.env.SCRAPER_CYCLE_INTERVAL_MS ??
            process.env.SCRAPE_INTERVAL_MS ??
            "60000",
          10,
        ),
      },
    });

    // ── proxy_state_at_startup ────────────────────────────────
    // One-shot snapshot of what the proxy config evaluator
    // ACTUALLY decided. Surfaces hidden-whitespace foot-guns
    // (raw_use_proxy_json shows the JSON escape of the env value,
    // including \n / \r / NBSP) without leaking the API key
    // (api_key_fingerprint is `${length}:${first4}…${last4}`).
    //
    // After this lands, "is the proxy enabled in production?" is
    // a one-query answer:
    //   /api/anomalies?event_type=proxy_state_at_startup&limit=1
    //
    // No more Railway-log spelunking required.
    const diag = getProxyDiagnostics();
    void logAnomaly({
      severity: "info",
      eventType: "proxy_state_at_startup",
      description: `scraper proxy: enabled=${diag.proxy_enabled} has_api_key=${diag.has_api_key}`,
      context: {
        ...diag,
        // List of WC-via-proxy vendors. Hardcoded here (rather than
        // imported from suppliers/index) to avoid a circular import
        // at startup; matches the 7 createWooModule() entries.
        // CAYMAN is omitted (paused, doesn't use the proxy path).
        vendors_via_proxy: [
          "PUREHEALTH",
          "NUSCIENCE",
          "VERIFIED",
          "LIBERTY",
          "GENETIC",
          "PULSE",
          "PURERAWZ",
          "SWISSCHEMS",
          "PANDA",
          "PURETESTED",
          "PEPTIDELABS",
        ],
      },
    });

    // ── vendor_onboarded ─────────────────────────────────────────
    // Fire one info event per active vendor that's currently
    // enabled_in_twap=false. This captures the "vendor is being
    // scraped but observations are quarantined from TWAP cohorts"
    // state on every fresh deploy, so the operations log answers
    // "which vendors are in the 7-day quality-review window?"
    // without scrolling back through migration history.
    //
    // Fires at every restart by design — the event is cheap and
    // the snapshot is useful confirmation, not a one-shot signal.
    // Pair with vendor_promoted_to_twap (worker) to see the full
    // lifecycle: onboarded → observed → promoted → producing prices.
    void (async () => {
      try {
        // Untyped client — `enabled_in_twap` exists in the schema
        // (migration 0036) but isn't in the generated Database types
        // yet. Switch to typed createAdminClient() once @peptide-oracle/db
        // is regenerated.
        const supabase = createAdminClientUntyped();
        const { data, error } = await supabase
          .from("suppliers")
          .select("code, enabled_in_twap")
          .eq("status", "active")
          .eq("enabled_in_twap", false);
        if (error) {
          console.warn(
            `[startup] vendor_onboarded query failed (non-fatal): ${error.message}`,
          );
          return;
        }
        for (const v of (data ?? []) as Array<{ code: string }>) {
          void logAnomaly({
            severity: "info",
            eventType: "vendor_onboarded",
            description: `vendor ${v.code} active, observations recorded but NOT in TWAP (enabled_in_twap=false)`,
            vendorId: v.code,
            context: {
              supplier_code: v.code,
              status: "active",
              enabled_in_twap: false,
            },
          });
        }

        // ── peptide_onboarded ──────────────────────────────────────
        // Same lifecycle pattern as vendor_onboarded. Migration 0038
        // adds peptides.enabled_in_twap (mirror of suppliers.enabled
        // _in_twap from 0036). New peptides land scrape-yes / twap-no
        // for a 7-day observation window; this event surfaces them
        // in the operations log on every fresh scraper deploy.
        const peptidesQ = await supabase
          .from("peptides")
          .select("code, enabled_in_twap")
          .eq("is_active", true)
          .eq("enabled_in_twap", false);
        if (peptidesQ.error) {
          console.warn(
            `[startup] peptide_onboarded query failed (non-fatal): ${peptidesQ.error.message}`,
          );
        } else {
          for (const p of (peptidesQ.data ?? []) as Array<{ code: string }>) {
            void logAnomaly({
              severity: "info",
              eventType: "peptide_onboarded",
              description: `peptide ${p.code} active, observations recorded but NOT in TWAP (enabled_in_twap=false)`,
              peptideId: p.code,
              context: {
                peptide_code: p.code,
                is_active: true,
                enabled_in_twap: false,
              },
            });
          }
        }
      } catch (err) {
        console.warn(
          `[startup] vendor/peptide onboarded threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  } else {
    console.warn(
      "[startup] SUPABASE_URL or SUPABASE_SECRET_KEY missing; anomaly log disabled (events will console.warn)",
    );
  }
}

/**
 * CLI entry. Two modes:
 *   pnpm dev / pnpm start  — loop forever, sleeping SCRAPER_CYCLE_INTERVAL_MS
 *                            between cycles (default 60s). Used in dev and
 *                            on Railway.
 *   pnpm once / --once     — run a single cycle and exit. Used for manual
 *                            testing, debugging, and from scripts.
 *
 * Cycle interval env var: SCRAPER_CYCLE_INTERVAL_MS is canonical; the older
 * SCRAPE_INTERVAL_MS is read as a fallback. Default 60000.
 *
 * Set SCRAPER_CYCLE_INTERVAL_MS=600000 (10 min) during ScrapingAnt
 * free-tier soak to stretch the 10k credit pool across ~7 days at ~6
 * credits/cycle.
 *
 * Health endpoint: HTTP GET /health on HEALTH_PORT (default 8080) returns
 * a JSON snapshot of cycle state. Healthy iff the last cycle finished
 * within 2× the cycle interval (one missed cycle tolerated). Railway uses
 * this for deployment health checks.
 *
 * Graceful shutdown: SIGTERM/SIGINT abort the inter-cycle sleep (so a
 * 10-minute scraper sleep doesn't blow Railway's typical 30s grace
 * window), let the in-flight cycle finish, close the health server, and
 * exit 0. We never leave a scraper_runs row stuck in 'running'.
 */
const intervalMs = Number.parseInt(
  process.env.SCRAPER_CYCLE_INTERVAL_MS ??
    process.env.SCRAPE_INTERVAL_MS ??
    "60000",
  10,
);

const healthPort = Number.parseInt(process.env.HEALTH_PORT ?? "8080", 10);

const runOnceFlag = process.argv.includes("--once");

const startedAt = new Date().toISOString();
const health: HealthState = {
  service: "scraper",
  started_at: startedAt,
  cycles_completed: 0,
  cycles_failed: 0,
  last_cycle_started_at: null,
  last_cycle_finished_at: null,
  last_cycle_status: null,
  last_cycle_duration_ms: null,
};

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

function fmtSummary(s: Awaited<ReturnType<typeof runOnce>>): string {
  return [
    `run=${s.runId}`,
    `status=${s.status}`,
    `${s.succeeded}/${s.attempted} ok`,
    `${s.failed} failed`,
    `${s.durationMs}ms`,
    s.proxyEnabled
      ? `proxy=on credits_session=${s.proxyCreditsSession}`
      : "proxy=off",
    s.errorSummary ? `errors=${s.errorSummary}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function safeCycle(): Promise<void> {
  health.last_cycle_started_at = new Date().toISOString();
  try {
    const summary = await runOnce();
    console.log(`[cycle] ${fmtSummary(summary)}`);
    health.cycles_completed += 1;
    health.last_cycle_status = summary.status;
    health.last_cycle_duration_ms = summary.durationMs;
    health.extra = {
      proxy_enabled: summary.proxyEnabled,
      proxy_credits_session: summary.proxyCreditsSession,
    };
  } catch (err) {
    // runOnce traps all per-product errors. A throw here means an
    // infrastructure failure (Supabase unreachable, env missing, etc.).
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[cycle] FAILED ${msg}`);
    health.cycles_failed += 1;
    health.last_cycle_status = "failed";
  } finally {
    health.last_cycle_finished_at = new Date().toISOString();
  }
}

async function main(): Promise<void> {
  // Health server is up for both --once and loop modes; --once just exits
  // before the next cycle would run, so the server lifetime is brief there.
  const healthServer = startHealthServer({
    port: healthPort,
    state: () => health,
    staleAfterMs: intervalMs * 2,
  });
  console.log(`[startup] health endpoint on :${healthPort}/health`);

  try {
    if (runOnceFlag) {
      await safeCycle();
      return;
    }

    console.log(
      `[startup] scraper looping on ${intervalMs}ms interval (--once for a single cycle)`,
    );
    while (!stopRequested) {
      await safeCycle();
      if (stopRequested) break;
      await sleepInterruptible(intervalMs, shutdownAbort.signal);
    }
    console.log("[shutdown] clean exit");
  } finally {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
