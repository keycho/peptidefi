import type { Request, Response } from "express";
import { adminClient } from "../supabase";
import { errors } from "../errors";
import { arbitrageQuerySchema } from "../validators";

/**
 * GET /arbitrage — public, no auth.
 *
 * Reads public.vendor_arbitrage (security_invoker=false; runs as the
 * view owner so anon callers see all rows). One row per active peptide
 * with ≥2 in-stock observations, ordered by spread_pct desc so the
 * biggest opportunities surface first.
 *
 * Query params:
 *   ?min_spread_pct=<number>  Only return peptides whose spread_pct is
 *                             ≥ N. Useful for "show me real arbitrage,
 *                             not 5% noise."
 *
 * Response shape (per spec): cheapest/most_expensive nested objects so
 * the markup directly reads `row.cheapest.url` etc., plus aggregate
 * fields total_addressable_arbitrage_pct + peptide_count.
 *
 * total_addressable_arbitrage_pct is the average spread_pct across the
 * peptides returned, in the same shape as the per-row spread_pct
 * (numeric string, 2 decimals). It's a rough proxy for "how much price
 * dispersion exists in the market right now"; not a tradable number.
 *
 * Numeric serialization: Postgres numeric → JS string via supabase-js;
 * we keep the precision as-is for prices (they're decimals you'd want
 * exact) and round spread_pct to 2 decimals for display.
 */

const DEFAULT_LIMIT = 50;

interface ArbitrageRow {
  peptide_id: number;
  peptide_code: string;
  peptide_display_name: string;
  peptide_category: string | null;
  cheapest_supplier_code: string;
  cheapest_supplier_display_name: string;
  cheapest_price_per_mg: string | number;
  cheapest_supplier_url: string | null;
  most_expensive_supplier_code: string;
  most_expensive_supplier_display_name: string;
  most_expensive_price_per_mg: string | number;
  most_expensive_supplier_url: string | null;
  spread_dollars: string | number;
  spread_pct: string | number | null;
  n_suppliers_in_comparison: number;
  last_updated_at: string;
}

function num(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function round2(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

function shapeRow(row: ArbitrageRow): Record<string, unknown> {
  return {
    peptide_code: row.peptide_code,
    peptide_display_name: row.peptide_display_name,
    peptide_category: row.peptide_category,
    cheapest: {
      supplier_code: row.cheapest_supplier_code,
      supplier_display_name: row.cheapest_supplier_display_name,
      price_per_mg: num(row.cheapest_price_per_mg),
      url: row.cheapest_supplier_url,
    },
    most_expensive: {
      supplier_code: row.most_expensive_supplier_code,
      supplier_display_name: row.most_expensive_supplier_display_name,
      price_per_mg: num(row.most_expensive_price_per_mg),
      url: row.most_expensive_supplier_url,
    },
    spread_dollars: num(row.spread_dollars),
    spread_pct: round2(row.spread_pct),
    n_suppliers: row.n_suppliers_in_comparison,
    last_updated_at: row.last_updated_at,
  };
}

export async function arbitrageHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = arbitrageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    errors.invalidInput(res, "min_spread_pct must be a non-negative number", {
      issues: parsed.error.issues,
    });
    return;
  }
  const minSpread = parsed.data.min_spread_pct;

  const supabase = adminClient();

  // The view isn't in our generated DB types, so cast at the boundary —
  // same trick as routes/leaderboard.ts and routes/vendors.ts.
  let query = (supabase
    .from("vendor_arbitrage" as never)
    .select("*")
    .order("spread_pct", { ascending: false, nullsFirst: false }) as unknown as {
      gte: (col: string, val: number) => unknown;
      limit: (n: number) => Promise<{
        data: ArbitrageRow[] | null;
        error: { message: string } | null;
      }>;
    });

  if (minSpread !== undefined) {
    query = query.gte("spread_pct", minSpread) as typeof query;
  }

  const result = await query.limit(DEFAULT_LIMIT);
  if (result.error) {
    errors.internal(res, `vendor_arbitrage read: ${result.error.message}`);
    return;
  }

  const rows = (result.data ?? []).map(shapeRow);

  // total_addressable_arbitrage_pct = mean of spread_pct over the
  // returned set. Skips rows where spread_pct is null (shouldn't
  // happen with our view, but defensive).
  let total: number | null = null;
  const valid = rows
    .map((r) => (typeof r.spread_pct === "string" ? Number(r.spread_pct) : null))
    .filter((n): n is number => n !== null && Number.isFinite(n));
  if (valid.length > 0) {
    total = valid.reduce((a, b) => a + b, 0) / valid.length;
  }

  res.json({
    arbitrage_opportunities: rows,
    total_addressable_arbitrage_pct: total === null ? null : total.toFixed(2),
    peptide_count: rows.length,
  });
}
