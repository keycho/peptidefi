import type { Request, Response } from "express";
import { adminClientUntyped } from "../../supabase";
import {
  loadOracleApiConfig,
  solscanUrl,
  solanaExplorerUrl,
} from "../../oracle-config";
import {
  getBalanceLamports,
  getConnection,
  recentSignaturesForAuthority,
} from "../../solana";
import { sendError } from "../../errors";

/**
 * GET /v1/status — oracle health summary.
 *
 * One JSON snapshot answering "is the oracle alive and committing".
 * Reads:
 *   - commit_cycles: counts by status, last finalized
 *   - twap_commits: counts by status, last finalized
 *   - on-chain wallet balance
 *   - recent on-chain signatures for the authority pubkey (sanity:
 *     does what's in the DB match what's on-chain)
 *
 * Designed for low-frequency polling (~1/min from a status page or
 * a frontend status badge). The on-chain calls (~2 RPC requests)
 * dominate the latency; the DB calls are sub-50ms aggregates.
 *
 * No auth: this is a public health endpoint. None of the values
 * returned are secret (pubkeys, signatures, slot numbers, balance
 * are all visible on-chain regardless).
 */
export async function statusHandler(_req: Request, res: Response): Promise<void> {
  const config = loadOracleApiConfig();
  const supabase = adminClientUntyped();

  // ─── DB aggregates (parallel) ─────────────────────────────────────
  const [cycles, twaps, lastFinalizedCycle, lastFinalizedTwap] =
    await Promise.all([
      supabase
        .from("commit_cycles")
        .select("status", { count: "exact", head: false })
        .then((r) => groupByStatus(r.data ?? [])),
      supabase
        .from("twap_commits")
        .select("status")
        .then((r) => groupByStatus(r.data ?? [])),
      supabase
        .from("commit_cycles")
        .select("cycle_id, finalized_at, solana_signature, solana_slot")
        .eq("status", "finalized")
        .order("finalized_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("twap_commits")
        .select("id, peptide_code, finalized_at, solana_signature, solana_slot, computed_at")
        .eq("status", "finalized")
        .order("finalized_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  // ─── On-chain (best-effort; tolerate flaky RPC) ────────────────────
  const conn = getConnection(config.rpcUrl);
  let balanceSol: string | null = null;
  let recentSigCount: number | null = null;
  try {
    const lamports = await getBalanceLamports(conn, config.authorityPubkey);
    balanceSol = (lamports / 1e9).toFixed(6);
  } catch {
    // leave null; non-critical
  }
  try {
    const sigs = await recentSignaturesForAuthority(
      conn,
      config.authorityPubkey,
      10,
    );
    recentSigCount = sigs?.length ?? null;
  } catch {
    /* non-critical */
  }

  res.json({
    service: "peptide-oracle-api",
    cluster: config.cluster,
    oracle_authority_pubkey: config.authorityPubkey,
    on_chain: {
      wallet_balance_sol: balanceSol,
      recent_signatures_count: recentSigCount,
    },
    cycle_commits: {
      counts: cycles,
      last_finalized: lastFinalizedCycle.data
        ? finalizedRefShape(
            String(lastFinalizedCycle.data.cycle_id),
            lastFinalizedCycle.data.solana_signature,
            lastFinalizedCycle.data.solana_slot,
            lastFinalizedCycle.data.finalized_at,
            config.cluster,
          )
        : null,
    },
    twap_commits: {
      counts: twaps,
      last_finalized: lastFinalizedTwap.data
        ? {
            ...finalizedRefShape(
              lastFinalizedTwap.data.id,
              lastFinalizedTwap.data.solana_signature,
              lastFinalizedTwap.data.solana_slot,
              lastFinalizedTwap.data.finalized_at,
              config.cluster,
            ),
            peptide_code: lastFinalizedTwap.data.peptide_code,
            computed_at: lastFinalizedTwap.data.computed_at,
          }
        : null,
    },
  });
  return;
  // The errors module's sendError is preserved as a hint that this
  // handler may grow auth/errors paths; not used in v1 (returns are
  // unconditionally 200 with whatever data is available).
  void sendError;
}

/* ─── Helpers ───────────────────────────────────────────────────── */

function groupByStatus(
  rows: { status: string | null }[],
): Record<string, number> {
  const out: Record<string, number> = {
    pending: 0,
    submitted: 0,
    finalized: 0,
    failed: 0,
  };
  for (const r of rows) {
    if (!r.status) continue;
    out[r.status] = (out[r.status] ?? 0) + 1;
  }
  return out;
}

interface FinalizedRef {
  id: string;
  solana_signature: string | null;
  solana_slot: number | null;
  finalized_at: string | null;
  solscan_url: string | null;
  explorer_url: string | null;
}

function finalizedRefShape(
  id: string,
  signature: string | null,
  slot: number | null,
  finalizedAt: string | null,
  cluster: ReturnType<typeof loadOracleApiConfig>["cluster"],
): FinalizedRef {
  return {
    id,
    solana_signature: signature,
    solana_slot: slot,
    finalized_at: finalizedAt,
    solscan_url: signature ? solscanUrl(signature, cluster) : null,
    explorer_url: signature ? solanaExplorerUrl(signature, cluster) : null,
  };
}
