import type { Request, Response } from "express";
import { adminClient } from "../supabase";
import { errors } from "../errors";
import { leaderboardQuerySchema } from "../validators";
import { toNumeric, type Numeric } from "@peptidefi/shared";

/**
 * GET /leaderboard — public, no auth.
 *
 * Reads the public.leaderboard view (security_invoker=false; the view
 * runs as its owner which bypasses RLS, so anon readers see all rows).
 *
 * Default: top 50 by rank.
 *
 * Optional ?include_user=<uuid>: if the user is outside the top 50, we
 * fetch their row separately and return it as `current_user`. If they
 * happen to BE in the top 50, current_user is null (the data is already
 * in the leaderboard array — no duplication).
 *
 * Numeric handling: the view returns balances/PnL as Postgres numeric;
 * supabase-js delivers them as JS strings (numeric → string preserves
 * precision in the wire JSON). We pass them through unchanged so
 * Lovable sees consistent decimal strings across all financial fields.
 */

const TOP_N = 50;

interface LeaderboardRow {
  rank: number;
  user_id: string;
  display_name: string;
  total_balance: string | number;
  realized_pnl: string | number;
  unrealized_pnl: string | number;
  total_equity: string | number;
  net_pnl: string | number;
  open_positions_count: number;
  total_trades: number;
  total_bets: number;
  open_bets_count: number;
  last_active_at: string;
}

function shapeRow(row: LeaderboardRow): Record<string, unknown> {
  return {
    rank: row.rank,
    user_id: row.user_id,
    display_name: row.display_name,
    total_balance: numericString(row.total_balance),
    realized_pnl: numericString(row.realized_pnl),
    unrealized_pnl: numericString(row.unrealized_pnl),
    total_equity: numericString(row.total_equity),
    net_pnl: numericString(row.net_pnl),
    open_positions_count: row.open_positions_count,
    total_trades: row.total_trades,
    total_bets: row.total_bets,
    open_bets_count: row.open_bets_count,
    last_active_at: row.last_active_at,
  };
}

function numericString(v: string | number | null | undefined): Numeric {
  if (v === null || v === undefined) return "0.000000";
  return toNumeric(String(v), 6);
}

export async function leaderboardHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = leaderboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    errors.invalidInput(res, "include_user must be a uuid", {
      issues: parsed.error.issues,
    });
    return;
  }
  const includeUser = parsed.data.include_user;

  const supabase = adminClient();

  // Top-N read.
  // The leaderboard view is not in our generated DB types (Supabase CLI
  // generates types for tables and functions, not views), so we cast at
  // the boundary.
  const top = await (supabase
    .from("leaderboard" as never)
    .select("*")
    .order("rank", { ascending: true })
    .limit(TOP_N) as unknown as Promise<{ data: LeaderboardRow[] | null; error: { message: string } | null }>);

  if (top.error) {
    errors.internal(res, `leaderboard read: ${top.error.message}`);
    return;
  }
  const leaderboardRows = (top.data ?? []).map(shapeRow);

  let currentUser: Record<string, unknown> | null = null;
  if (includeUser) {
    const inTop = leaderboardRows.some((r) => r.user_id === includeUser);
    if (!inTop) {
      const single = await (supabase
        .from("leaderboard" as never)
        .select("*")
        .eq("user_id", includeUser)
        .maybeSingle() as unknown as Promise<{
          data: LeaderboardRow | null;
          error: { message: string } | null;
        }>);
      if (single.error) {
        errors.internal(res, `leaderboard include_user: ${single.error.message}`);
        return;
      }
      if (single.data) currentUser = shapeRow(single.data);
    }
  }

  res.json({
    leaderboard: leaderboardRows,
    current_user: currentUser,
  });
}
