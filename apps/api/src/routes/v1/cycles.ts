import type { Request, Response } from "express";
import { z } from "zod";
import { adminClientUntyped } from "../../supabase";
import {
  loadOracleApiConfig,
  solscanUrl,
  solanaExplorerUrl,
} from "../../oracle-config";
import { sendError } from "../../errors";

/**
 * GET /v1/cycles — paginated list of cycle commits.
 * GET /v1/cycles/:id — single cycle commit with observations inline.
 *
 * The list endpoint mirrors §05.4.1 with two simplifications for v1:
 *   - cursor pagination is offset-based instead of opaque-token (the
 *     cycle_id is monotonic; (id, limit) is enough).
 *   - status defaults to 'finalized' (matches spec); 'all' supported.
 *
 * The detail endpoint inlines observations rather than offering a
 * separate /cycles/:id/observations endpoint (§05.4.3 in the spec)
 * since v1 cycles top out at low-thousands of observations and the
 * extra round-trip isn't worth the API surface complexity. The
 * response also includes the cycle's full memo_payload (§05.4.2),
 * letting verifiers byte-compare against on-chain without an extra
 * round-trip.
 */

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
  status: z
    .enum(["pending", "submitted", "finalized", "failed", "all"])
    .default("finalized"),
});

export async function listCyclesHandler(req: Request, res: Response): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return;
  }
  const { limit, cursor, status } = parsed.data;
  const supabase = adminClientUntyped();
  const config = loadOracleApiConfig();

  let query = supabase
    .from("commit_cycles")
    .select(
      "cycle_id, started_at, completed_at, observation_count, merkle_root, status, solana_signature, solana_slot, submitted_at, finalized_at",
    )
    .order("cycle_id", { ascending: false })
    .limit(limit);
  if (status !== "all") {
    query = query.eq("status", status);
  }
  if (cursor !== undefined) {
    query = query.lt("cycle_id", cursor);
  }
  const { data, error } = await query;
  if (error) {
    sendError(res, 500, "DB_ERROR", `commit_cycles list failed: ${error.message}`);
    return;
  }
  const rows = data ?? [];
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1]!.cycle_id : null;

  res.json({
    cycles: rows.map((r) => shapeCycle(r, config.cluster)),
    next_cursor: nextCursor,
  });
}

export async function getCycleHandler(req: Request, res: Response): Promise<void> {
  const idParam = req.params.id;
  if (!idParam || !/^\d+$/.test(idParam)) {
    sendError(res, 400, "BAD_REQUEST", "cycle_id must be a positive integer");
    return;
  }
  const cycleId = Number(idParam);
  const supabase = adminClientUntyped();
  const config = loadOracleApiConfig();

  // 1. Cycle row.
  const { data: cycle, error: cErr } = await supabase
    .from("commit_cycles")
    .select(
      "cycle_id, started_at, completed_at, observation_count, merkle_root, memo_payload, status, solana_signature, solana_slot, submitted_at, finalized_at, retry_count, last_error",
    )
    .eq("cycle_id", cycleId)
    .maybeSingle();
  if (cErr) {
    sendError(res, 500, "DB_ERROR", `cycle lookup failed: ${cErr.message}`);
    return;
  }
  if (!cycle) {
    sendError(
      res,
      404,
      "NOT_FOUND",
      `cycle ${cycleId} has no commit record (may exist in scraper_runs without a commit)`,
    );
    return;
  }

  // 2. Junction rows (commit_observations) — one row per leaf.
  const { data: junction, error: jErr } = await supabase
    .from("commit_observations")
    .select("observation_id, leaf_hash, leaf_index")
    .eq("cycle_id", cycleId)
    .order("leaf_index", { ascending: true });
  if (jErr) {
    sendError(res, 500, "DB_ERROR", `commit_observations failed: ${jErr.message}`);
    return;
  }

  res.json({
    ...shapeCycle(cycle, config.cluster),
    memo_payload: cycle.memo_payload,
    retry_count: cycle.retry_count ?? 0,
    last_error: cycle.last_error ?? null,
    observations: (junction ?? []).map((j) => ({
      observation_id: typeof j.observation_id === "string" ? Number(j.observation_id) : j.observation_id,
      leaf_index: j.leaf_index,
      leaf_hash: j.leaf_hash,
    })),
  });
}

/* ─── Helpers ───────────────────────────────────────────────────── */

interface CycleRow {
  cycle_id: number | string;
  started_at: string;
  completed_at: string;
  observation_count: number;
  merkle_root: string;
  status: string | null;
  solana_signature: string | null;
  solana_slot: number | string | null;
  submitted_at: string | null;
  finalized_at: string | null;
}

function shapeCycle(
  row: CycleRow,
  cluster: ReturnType<typeof loadOracleApiConfig>["cluster"],
): Record<string, unknown> {
  const cycleId = typeof row.cycle_id === "string" ? Number(row.cycle_id) : row.cycle_id;
  const slot =
    row.solana_slot === null
      ? null
      : typeof row.solana_slot === "string"
        ? Number(row.solana_slot)
        : row.solana_slot;
  return {
    cycle_id: cycleId,
    started_at: row.started_at,
    completed_at: row.completed_at,
    observation_count: row.observation_count,
    merkle_root: row.merkle_root,
    status: row.status,
    solana: row.solana_signature
      ? {
          signature: row.solana_signature,
          slot,
          cluster,
          solscan_url: solscanUrl(row.solana_signature, cluster),
          explorer_url: solanaExplorerUrl(row.solana_signature, cluster),
        }
      : null,
    submitted_at: row.submitted_at,
    finalized_at: row.finalized_at,
  };
}
