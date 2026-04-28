import type { Request, Response } from "express";
import { adminClient } from "../supabase";
import { errors } from "../errors";

/**
 * GET /vendors/leaderboard — public, no auth.
 *
 * Reads public.vendor_leaderboard (security_invoker=false; runs with
 * the view owner's privileges, so anon callers see all rows). One row
 * per active supplier (suppliers.status = 'active'), ordered by rank.
 *
 * Numeric columns from the view (in_stock_rate, cheapest_pct,
 * avg_spread_vs_twap, composite_score) come back as JS strings via
 * supabase-js — that preserves precision in JSON. We pass them
 * through unchanged so Lovable sees the same decimal-string format
 * as /leaderboard. Integer columns (coverage_count, update_frequency,
 * freshness_seconds, supplier_id, rank) come back as numbers and stay
 * that way.
 */

interface VendorLeaderboardRow {
  rank: number;
  supplier_id: number;
  supplier_code: string;
  supplier_display_name: string;
  logo_url: string | null;
  coverage_count: number;
  in_stock_rate: string | number;
  update_frequency: number;
  cheapest_pct: string | number;
  avg_spread_vs_twap: string | number | null;
  freshness_seconds: number;
  composite_score: string | number;
}

function shapeRow(row: VendorLeaderboardRow): Record<string, unknown> {
  return {
    rank: row.rank,
    supplier_code: row.supplier_code,
    supplier_display_name: row.supplier_display_name,
    logo_url: row.logo_url,
    coverage_count: row.coverage_count,
    in_stock_rate: String(row.in_stock_rate),
    update_frequency: row.update_frequency,
    cheapest_pct: String(row.cheapest_pct),
    avg_spread_vs_twap:
      row.avg_spread_vs_twap == null ? null : String(row.avg_spread_vs_twap),
    freshness_seconds: row.freshness_seconds,
    composite_score: String(row.composite_score),
  };
}

export async function vendorLeaderboardHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const supabase = adminClient();

  // The view isn't in our generated DB types (Supabase CLI emits types
  // for tables and functions, not views), so we cast at the boundary —
  // same trick as routes/leaderboard.ts uses for public.leaderboard.
  const result = await (supabase
    .from("vendor_leaderboard" as never)
    .select("*")
    .order("rank", { ascending: true }) as unknown as Promise<{
      data: VendorLeaderboardRow[] | null;
      error: { message: string } | null;
    }>);

  if (result.error) {
    errors.internal(res, `vendor_leaderboard read: ${result.error.message}`);
    return;
  }

  res.json({ vendors: (result.data ?? []).map(shapeRow) });
}
