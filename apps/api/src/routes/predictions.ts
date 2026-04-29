import type { Request, Response } from "express";
import { adminClient } from "../supabase";
import { errors } from "../errors";
import {
  placeBetSchema,
  predictionDetailQuerySchema,
  resolveMarketSchema,
} from "../validators";

/**
 * Prediction-market endpoints.
 *
 *   GET  /predictions                 — public list (prediction_market_stats)
 *   GET  /predictions/:slug           — public detail (+ ?include_user=<uuid>)
 *   POST /predictions/:slug/bet       — auth, calls place_bet RPC
 *   GET  /predictions/me              — auth, user's open + resolved bets
 *   POST /admin/predictions/:slug/resolve — auth + is_admin, calls resolve_market RPC
 *
 * RPC error → HTTP mapping (PG SQLSTATE codes set in 0028 migration):
 *   P0021 IDEMPOTENCY_KEY_REUSED_DIFFERENT_PARAMS → 409
 *   P0022 / P0033 MARKET_NOT_FOUND                 → 404
 *   P0023 MARKET_NOT_OPEN                          → 409
 *   P0024 MARKET_CLOSED                            → 409
 *   P0025 BELOW_MIN_BET                            → 400
 *   P0026 EXCEEDS_USER_LIMIT                       → 400
 *   P0027 INSUFFICIENT_BALANCE                     → 402
 *   P0031 INVALID_OUTCOME                          → 400
 *   P0032 NOT_AUTHORIZED                           → 403
 *   P0034 MARKET_NOT_RESOLVABLE                    → 409
 *
 * Numeric serialization: matches the rest of the API. Postgres numeric
 * comes through supabase-js as a JS string; we pass it through unchanged
 * so Lovable sees consistent decimal strings across all financial fields.
 */

interface MarketStatsRow {
  id: string;
  slug: string;
  question: string;
  category: string;
  resolution_criteria: string;
  resolution_date: string;
  closes_at: string;
  yes_pool: string | number;
  no_pool: string | number;
  total_pool: string | number;
  implied_yes_probability: string | number;
  implied_no_probability: string | number;
  status: string;
  resolved_at: string | null;
  min_bet_points: string | number;
  max_bet_points_per_user: string | number;
  total_bet_count: number;
  unique_better_count: number;
}

interface BetRow {
  id: string;
  market_id: string;
  user_id: string;
  side: "yes" | "no";
  stake_points: string | number;
  yes_pool_at_bet: string | number;
  no_pool_at_bet: string | number;
  implied_yes_probability: string | number;
  status: "open" | "won" | "lost" | "refunded";
  payout_points: string | number | null;
  settled_at: string | null;
  idempotency_key: string;
  created_at: string;
}

function s(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function shapeMarket(row: MarketStatsRow): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    question: row.question,
    category: row.category,
    resolution_criteria: row.resolution_criteria,
    resolution_date: row.resolution_date,
    closes_at: row.closes_at,
    yes_pool: s(row.yes_pool),
    no_pool: s(row.no_pool),
    total_pool: s(row.total_pool),
    implied_yes_probability: s(row.implied_yes_probability),
    implied_no_probability: s(row.implied_no_probability),
    status: row.status,
    resolved_at: row.resolved_at,
    total_bet_count: row.total_bet_count,
    unique_better_count: row.unique_better_count,
    min_bet_points: s(row.min_bet_points),
    max_bet_points_per_user: s(row.max_bet_points_per_user),
  };
}

function shapeBet(row: BetRow): Record<string, unknown> {
  return {
    id: row.id,
    market_id: row.market_id,
    side: row.side,
    stake_points: s(row.stake_points),
    yes_pool_at_bet: s(row.yes_pool_at_bet),
    no_pool_at_bet: s(row.no_pool_at_bet),
    implied_yes_probability: s(row.implied_yes_probability),
    status: row.status,
    payout_points: s(row.payout_points),
    settled_at: row.settled_at,
    created_at: row.created_at,
  };
}

// ─── GET /predictions ──────────────────────────────────────────────────
export async function listPredictionsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  // Generated DB types are stale for prediction_bets, the v0.5 schema of
  // prediction_markets (was bigint PK pre-0028, uuid now), and the new
  // RPCs (place_bet / resolve_market). Until the codegen runs, we opt
  // out of typing for these calls — same workaround as routes/leaderboard.
  const supabase = adminClient() as unknown as {
    from: (t: string) => {
      select: (cols: string) => any;
    };
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const result = await (supabase
    .from("prediction_market_stats" as never)
    .select("*")
    .order("resolution_date", { ascending: true }) as unknown as Promise<{
      data: MarketStatsRow[] | null;
      error: { message: string } | null;
    }>);
  if (result.error) {
    errors.internal(res, `prediction_market_stats read: ${result.error.message}`);
    return;
  }
  const markets = (result.data ?? []).map(shapeMarket);
  res.json({ markets, total_markets: markets.length });
}

// ─── GET /predictions/:slug ────────────────────────────────────────────
export async function getPredictionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = req.params.slug;
  if (!slug) {
    errors.invalidInput(res, "slug is required");
    return;
  }
  const parsed = predictionDetailQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    errors.invalidInput(res, "include_user must be a uuid", {
      issues: parsed.error.issues,
    });
    return;
  }
  const includeUser = parsed.data.include_user;

  // Generated DB types are stale for prediction_bets, the v0.5 schema of
  // prediction_markets (was bigint PK pre-0028, uuid now), and the new
  // RPCs (place_bet / resolve_market). Until the codegen runs, we opt
  // out of typing for these calls — same workaround as routes/leaderboard.
  const supabase = adminClient() as unknown as {
    from: (t: string) => {
      select: (cols: string) => any;
    };
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const marketResult = await (supabase
    .from("prediction_market_stats" as never)
    .select("*")
    .eq("slug", slug)
    .maybeSingle() as unknown as Promise<{
      data: MarketStatsRow | null;
      error: { message: string } | null;
    }>);
  if (marketResult.error) {
    errors.internal(res, `prediction_market_stats read: ${marketResult.error.message}`);
    return;
  }
  if (!marketResult.data) {
    errors.marketNotFound(res, slug);
    return;
  }

  const body: Record<string, unknown> = {
    market: shapeMarket(marketResult.data),
  };

  if (includeUser) {
    const betsResult = await (supabase
      .from("prediction_bets")
      .select("*")
      .eq("market_id", marketResult.data.id)
      .eq("user_id", includeUser)
      .order("created_at", { ascending: false }) as unknown as Promise<{
        data: BetRow[] | null;
        error: { message: string } | null;
      }>);
    if (betsResult.error) {
      errors.internal(res, `bets read: ${betsResult.error.message}`);
      return;
    }
    body.user_bets = (betsResult.data ?? []).map(shapeBet);
  }

  res.json(body);
}

// ─── POST /predictions/:slug/bet ───────────────────────────────────────
export async function placeBetHandler(
  req: Request & { user?: { id: string } },
  res: Response,
): Promise<void> {
  const user = req.user;
  if (!user) {
    errors.invalidInput(res, "auth required");
    return;
  }
  const slug = req.params.slug;
  if (!slug) {
    errors.invalidInput(res, "slug is required");
    return;
  }
  const parsed = placeBetSchema.safeParse(req.body);
  if (!parsed.success) {
    errors.invalidInput(res, "request body invalid", { issues: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  const stake = typeof body.stake_points === "string" ? Number(body.stake_points) : body.stake_points;
  if (!Number.isFinite(stake) || stake <= 0) {
    errors.invalidInput(res, "stake_points must be > 0");
    return;
  }

  // Generated DB types are stale for prediction_bets, the v0.5 schema of
  // prediction_markets (was bigint PK pre-0028, uuid now), and the new
  // RPCs (place_bet / resolve_market). Until the codegen runs, we opt
  // out of typing for these calls — same workaround as routes/leaderboard.
  const supabase = adminClient() as unknown as {
    from: (t: string) => {
      select: (cols: string) => any;
    };
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };

  // Look up market_id by slug.
  const marketLookup = await (supabase
    .from("prediction_markets")
    .select("id, status, closes_at, min_bet_points")
    .eq("slug", slug)
    .maybeSingle() as unknown as Promise<{
      data: { id: string; status: string; closes_at: string; min_bet_points: string | number } | null;
      error: { message: string } | null;
    }>);
  if (marketLookup.error) {
    errors.internal(res, `market lookup: ${marketLookup.error.message}`);
    return;
  }
  if (!marketLookup.data) {
    errors.marketNotFound(res, slug);
    return;
  }
  const market = marketLookup.data;

  // Atomic placement via RPC.
  const { data, error } = await supabase.rpc("place_bet", {
    p_user_id: user.id,
    p_market_id: market.id,
    p_side: body.side,
    p_stake_points: stake,
    p_idempotency_key: body.idempotency_key,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("IDEMPOTENCY_KEY_REUSED_DIFFERENT_PARAMS")) {
      errors.idempotencyKeyReusedDifferentParams(res);
      return;
    }
    if (msg.includes("MARKET_NOT_OPEN")) {
      errors.marketNotOpen(res, market.status);
      return;
    }
    if (msg.includes("MARKET_CLOSED")) {
      errors.marketClosed(res);
      return;
    }
    if (msg.includes("MARKET_NOT_FOUND")) {
      errors.marketNotFound(res);
      return;
    }
    if (msg.includes("BELOW_MIN_BET")) {
      errors.belowMinBet(res, String(market.min_bet_points));
      return;
    }
    if (msg.includes("EXCEEDS_USER_LIMIT")) {
      errors.exceedsUserLimit(res, "5000");  // RPC doesn't return the cap; we re-state the spec default
      return;
    }
    if (msg.includes("INSUFFICIENT_BALANCE")) {
      errors.insufficientBalance(res, "?", String(stake));
      return;
    }
    errors.internal(res, `place_bet rpc: ${msg}`);
    return;
  }

  const result = data as unknown as {
    idempotent: boolean;
    bet_id: string;
    market_id: string;
    side: "yes" | "no";
    stake_points: string | number;
    status?: string;
    yes_pool?: string | number;
    no_pool?: string | number;
    implied_yes_probability?: string | number;
  };

  res.status(result.idempotent ? 200 : 201).json({
    idempotent: result.idempotent,
    bet_id: result.bet_id,
    market: {
      id: result.market_id,
      yes_pool: s(result.yes_pool ?? null),
      no_pool: s(result.no_pool ?? null),
      implied_yes_probability: s(result.implied_yes_probability ?? null),
    },
    side: result.side,
    stake_points: s(result.stake_points),
  });
}

// ─── GET /predictions/me ───────────────────────────────────────────────
export async function listMyBetsHandler(
  req: Request & { user?: { id: string } },
  res: Response,
): Promise<void> {
  const user = req.user;
  if (!user) {
    errors.invalidInput(res, "auth required");
    return;
  }
  // Generated DB types are stale for prediction_bets, the v0.5 schema of
  // prediction_markets (was bigint PK pre-0028, uuid now), and the new
  // RPCs (place_bet / resolve_market). Until the codegen runs, we opt
  // out of typing for these calls — same workaround as routes/leaderboard.
  const supabase = adminClient() as unknown as {
    from: (t: string) => {
      select: (cols: string) => any;
    };
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };

  // Bets joined with market slug + question for client convenience.
  const result = await (supabase
    .from("prediction_bets")
    .select("*, prediction_markets!inner(slug, question, status)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false }) as unknown as Promise<{
      data: (BetRow & {
        prediction_markets: { slug: string; question: string; status: string };
      })[] | null;
      error: { message: string } | null;
    }>);
  if (result.error) {
    errors.internal(res, `bets read: ${result.error.message}`);
    return;
  }
  const rows = (result.data ?? []).map((row) => ({
    ...shapeBet(row),
    market_slug: row.prediction_markets.slug,
    market_question: row.prediction_markets.question,
    market_status: row.prediction_markets.status,
  }));
  res.json({ bets: rows, total_bets: rows.length });
}

// ─── POST /admin/predictions/:slug/resolve ─────────────────────────────
export async function resolveMarketHandler(
  req: Request & { user?: { id: string } },
  res: Response,
): Promise<void> {
  const user = req.user;
  if (!user) {
    errors.invalidInput(res, "auth required");
    return;
  }
  const slug = req.params.slug;
  if (!slug) {
    errors.invalidInput(res, "slug is required");
    return;
  }
  const parsed = resolveMarketSchema.safeParse(req.body);
  if (!parsed.success) {
    errors.invalidInput(res, "request body invalid", { issues: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  // Generated DB types are stale for prediction_bets, the v0.5 schema of
  // prediction_markets (was bigint PK pre-0028, uuid now), and the new
  // RPCs (place_bet / resolve_market). Until the codegen runs, we opt
  // out of typing for these calls — same workaround as routes/leaderboard.
  const supabase = adminClient() as unknown as {
    from: (t: string) => {
      select: (cols: string) => any;
    };
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };

  // Pre-flight admin check (RPC also enforces; doing it here gives a
  // clean 403 without needing to parse the RPC error).
  const adminCheck = await (supabase
    .from("users")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle() as unknown as Promise<{
      data: { is_admin: boolean } | null;
      error: { message: string } | null;
    }>);
  if (adminCheck.error) {
    errors.internal(res, `admin check: ${adminCheck.error.message}`);
    return;
  }
  if (!adminCheck.data?.is_admin) {
    errors.notAuthorized(res);
    return;
  }

  // Look up market_id + current status by slug.
  const marketLookup = await (supabase
    .from("prediction_markets")
    .select("id, status")
    .eq("slug", slug)
    .maybeSingle() as unknown as Promise<{
      data: { id: string; status: string } | null;
      error: { message: string } | null;
    }>);
  if (marketLookup.error) {
    errors.internal(res, `market lookup: ${marketLookup.error.message}`);
    return;
  }
  if (!marketLookup.data) {
    errors.marketNotFound(res, slug);
    return;
  }
  const market = marketLookup.data;

  const { data, error } = await supabase.rpc("resolve_market", {
    p_market_id: market.id,
    p_outcome: body.outcome,
    p_resolver_id: user.id,
    p_notes: body.notes ?? null,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("NOT_AUTHORIZED")) {
      errors.notAuthorized(res);
      return;
    }
    if (msg.includes("INVALID_OUTCOME")) {
      errors.invalidOutcome(res, body.outcome);
      return;
    }
    if (msg.includes("MARKET_NOT_FOUND")) {
      errors.marketNotFound(res, slug);
      return;
    }
    if (msg.includes("MARKET_NOT_RESOLVABLE")) {
      errors.marketNotResolvable(res, market.status);
      return;
    }
    errors.internal(res, `resolve_market rpc: ${msg}`);
    return;
  }

  const result = data as unknown as {
    market_id: string;
    outcome: string;
    n_winners: number;
    n_losers: number;
    total_payout: string | number;
    new_status: string;
  };

  res.json({
    market_id: result.market_id,
    outcome: result.outcome,
    new_status: result.new_status,
    n_winners: result.n_winners,
    n_losers: result.n_losers,
    total_payout: s(result.total_payout),
  });
}
