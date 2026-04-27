import type { Request, Response } from "express";
import { bn, toNumeric, type Numeric } from "@peptidefi/shared";
import { adminClient } from "../supabase";
import { requireUser } from "../auth";
import { errors } from "../errors";
import {
  openPositionSchema,
  listPositionsQuerySchema,
  uuidParamSchema,
  type OpenPositionInput,
} from "../validators";

/**
 * Trading endpoints — open/close/list/get positions.
 *
 * Atomic correctness lives in the open_position and close_position
 * PL/pgSQL functions (migration 0016). The handlers here:
 *   1. Validate input shape with zod.
 *   2. Pre-fetch peptide + latest TWAP so we can return clean error
 *      codes (PEPTIDE_NOT_FOUND, MARKET_DATA_STALE) BEFORE going to the
 *      RPC, instead of decoding a Postgres exception message.
 *   3. Call the RPC, which atomically locks the user's balance row,
 *      checks balance again under lock, inserts the position, debits
 *      the balance, and appends the ledger entry.
 *   4. Map RPC errors to our error code matrix.
 *   5. Compute live unrealized PnL on read endpoints (open positions
 *      only — closed positions just echo realized_pnl_points).
 *
 * Numeric handling: prices, balances, and sizes flow through the RPC
 * as decimal STRINGs (zod-validated input → string → Postgres numeric).
 * supabase-js serialises strings into the JSON wire payload unchanged
 * so Postgres receives the exact decimal. The JSON returned by the RPC
 * comes back with numbers (Postgres → JS Number), which we convert to
 * decimal STRINGS via toNumeric() at the API boundary so consumers see
 * a consistent type.
 */

const TWAP_STALENESS_THRESHOLD_SECONDS = 300; // 5 minutes per spec

interface PeptideRow {
  id: number;
  code: string;
  display_name: string;
  is_active: boolean;
}

interface LatestTwapRow {
  id: number;
  twap_usd_per_mg: string; // numeric → string at boundary
  computed_at: string;
}

/** Convert any incoming numeric (number | string | null) to Numeric string. */
function n(v: number | string | null | undefined, dp = 6): Numeric | null {
  if (v === null || v === undefined) return null;
  return toNumeric(bn(String(v)), dp);
}

/** Compute live PnL for an open position given the current TWAP. */
function computeLivePnL(args: {
  direction: "long" | "short";
  entrySize: Numeric;
  entryTwap: Numeric;
  currentTwap: Numeric;
}): {
  pct_change_from_entry: Numeric;
  unrealized_pnl_points: Numeric;
  current_value_points: Numeric;
} {
  const entryTwap = bn(args.entryTwap);
  const currentTwap = bn(args.currentTwap);
  const entrySize = bn(args.entrySize);
  const pct = currentTwap.minus(entryTwap).div(entryTwap);
  const directional = args.direction === "long" ? pct : pct.negated();
  const pnl = entrySize.times(directional);
  // Bounded loss clamp: value cannot go below zero.
  const value = entrySize.plus(pnl);
  const valueClamped = value.isNegative() ? bn(0) : value;
  const unrealizedClamped = valueClamped.minus(entrySize);
  return {
    pct_change_from_entry: toNumeric(pct, 6),
    unrealized_pnl_points: toNumeric(unrealizedClamped, 6),
    current_value_points: toNumeric(valueClamped, 6),
  };
}

/**
 * Look up the peptide by code, requiring is_active=true. Returns null
 * if not found (caller surfaces PEPTIDE_NOT_FOUND).
 */
async function getActivePeptide(code: string): Promise<PeptideRow | null> {
  const supabase = adminClient();
  const { data, error } = await supabase
    .from("peptides")
    .select("id, code, display_name, is_active")
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Latest non-null TWAP for a peptide. Null if none ever published.
 */
async function getLatestTwap(peptideId: number): Promise<LatestTwapRow | null> {
  const supabase = adminClient();
  const { data, error } = await supabase
    .from("peptide_twaps")
    .select("id, twap_usd_per_mg, computed_at")
    .eq("peptide_id", peptideId)
    .not("twap_usd_per_mg", "is", null)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    twap_usd_per_mg: String(data.twap_usd_per_mg),
    computed_at: data.computed_at,
  };
}

interface PositionRow {
  id: string;
  user_id: string;
  peptide_id: number;
  direction: "long" | "short";
  entry_size_points: string | number;
  entry_twap_usd_per_mg: string | number;
  opened_at: string;
  closed_at: string | null;
  exit_twap_usd_per_mg: string | number | null;
  realized_pnl_points: string | number | null;
  status: "open" | "closed";
  idempotency_key: string;
  entry_peptide_twap_id: number | null;
  exit_peptide_twap_id: number | null;
}

/** Shape position row for API response — numeric fields as decimal strings. */
function shapePosition(row: PositionRow): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    peptide_id: row.peptide_id,
    direction: row.direction,
    entry_size_points: n(row.entry_size_points)!,
    entry_twap_usd_per_mg: n(row.entry_twap_usd_per_mg)!,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    exit_twap_usd_per_mg: n(row.exit_twap_usd_per_mg),
    realized_pnl_points: n(row.realized_pnl_points),
    status: row.status,
    idempotency_key: row.idempotency_key,
    entry_peptide_twap_id: row.entry_peptide_twap_id,
    exit_peptide_twap_id: row.exit_peptide_twap_id,
  };
}

/**
 * Compare an existing position row against an incoming open request.
 * Returns the conflicting fields if the body would have produced a
 * different position, or null if the request is a true retry.
 */
function diffOpenRequest(
  existing: PositionRow,
  peptideId: number,
  body: OpenPositionInput,
): Record<string, unknown> | null {
  const conflicts: Record<string, unknown> = {};
  if (existing.peptide_id !== peptideId) {
    conflicts.peptide_id = { existing: existing.peptide_id, requested: peptideId };
  }
  if (existing.direction !== body.direction) {
    conflicts.direction = { existing: existing.direction, requested: body.direction };
  }
  // Compare sizes via BigNumber to dodge "1000" vs "1000.000000" false alarms.
  if (!bn(existing.entry_size_points).eq(bn(body.size_points))) {
    conflicts.size_points = {
      existing: n(existing.entry_size_points),
      requested: body.size_points,
    };
  }
  return Object.keys(conflicts).length === 0 ? null : conflicts;
}

// ─── POST /positions/open ──────────────────────────────────────────────────
export async function openPositionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(req);

  const parsed = openPositionSchema.safeParse(req.body);
  if (!parsed.success) {
    errors.invalidInput(res, parsed.error.issues[0]?.message ?? "invalid input", {
      issues: parsed.error.issues,
    });
    return;
  }
  const body = parsed.data;

  // Pre-checks for clean error codes.
  let peptide: PeptideRow | null;
  try {
    peptide = await getActivePeptide(body.peptide_code);
  } catch (err) {
    errors.internal(res, `peptide lookup: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!peptide) {
    errors.peptideNotFound(res, body.peptide_code);
    return;
  }

  let twap: LatestTwapRow | null;
  try {
    twap = await getLatestTwap(peptide.id);
  } catch (err) {
    errors.internal(res, `twap lookup: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!twap) {
    errors.marketDataStale(res, body.peptide_code, Number.POSITIVE_INFINITY, null);
    return;
  }
  const ageSec = Math.floor((Date.now() - new Date(twap.computed_at).getTime()) / 1000);
  if (ageSec > TWAP_STALENESS_THRESHOLD_SECONDS) {
    errors.marketDataStale(res, body.peptide_code, ageSec, twap.computed_at);
    return;
  }

  // Optional pre-balance check — gives a clean INSUFFICIENT_BALANCE before
  // hitting the RPC. The RPC re-checks under SELECT FOR UPDATE so a race
  // where balance drops between our read and the lock acquisition still
  // produces the right outcome (RPC raises INSUFFICIENT_BALANCE → mapped
  // below).
  const supabase = adminClient();
  const { data: bal } = await supabase
    .from("point_balances")
    .select("balance")
    .eq("user_id", user.id)
    .maybeSingle();
  if (bal && bn(String(bal.balance)).lt(bn(body.size_points))) {
    errors.insufficientBalance(res, String(bal.balance), body.size_points);
    return;
  }

  // Atomic open via RPC.
  const { data, error } = await supabase.rpc("open_position", {
    p_user_id: user.id,
    p_peptide_id: peptide.id,
    p_direction: body.direction,
    p_size_points: Number(body.size_points),
    p_entry_twap: Number(twap.twap_usd_per_mg),
    p_entry_peptide_twap_id: twap.id,
    p_idempotency_key: body.idempotency_key,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("INSUFFICIENT_BALANCE")) {
      // Race won — the RPC's locked re-check caught a drop below threshold.
      const m = /balance=([\d.]+)\s+requested=([\d.]+)/.exec(msg);
      errors.insufficientBalance(res, m?.[1] ?? "?", m?.[2] ?? body.size_points);
      return;
    }
    if (msg.includes("BALANCE_ROW_MISSING")) {
      errors.internal(res, "user has no point_balances row — auth trigger may have failed");
      return;
    }
    errors.internal(res, `open_position rpc: ${msg}`);
    return;
  }

  const result = data as unknown as {
    position: PositionRow;
    new_balance: number | string;
    idempotent: boolean;
  };

  // Idempotency body-mismatch check.
  if (result.idempotent) {
    const conflicts = diffOpenRequest(result.position, peptide.id, body);
    if (conflicts) {
      errors.idempotencyKeyReused(res, conflicts);
      return;
    }
  }

  res.status(result.idempotent ? 200 : 201).json({
    position: shapePosition(result.position),
    new_balance: n(result.new_balance)!,
    idempotent: result.idempotent,
  });
}

// ─── POST /positions/:id/close ─────────────────────────────────────────────
export async function closePositionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(req);

  const parsedParams = uuidParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    errors.invalidInput(res, "invalid position id (must be uuid)");
    return;
  }
  const positionId = parsedParams.data.id;

  // Read the position to look up peptide_id for staleness check. We DON'T
  // trust the row's status here — the RPC re-locks and decides
  // open vs idempotent. POSITION_NOT_FOUND covers both "no row" and
  // "row exists but not yours" so we don't leak existence.
  const supabase = adminClient();
  const { data: pos, error: posErr } = await supabase
    .from("positions")
    .select("id, user_id, peptide_id, status")
    .eq("id", positionId)
    .maybeSingle();
  if (posErr) {
    errors.internal(res, `position lookup: ${posErr.message}`);
    return;
  }
  if (!pos || pos.user_id !== user.id) {
    errors.positionNotFound(res);
    return;
  }

  const twap = await getLatestTwap(pos.peptide_id);
  if (!twap) {
    // Look up peptide code for the error message.
    const { data: pep } = await supabase
      .from("peptides")
      .select("code")
      .eq("id", pos.peptide_id)
      .maybeSingle();
    errors.marketDataStale(res, pep?.code ?? "?", Number.POSITIVE_INFINITY, null);
    return;
  }
  const ageSec = Math.floor((Date.now() - new Date(twap.computed_at).getTime()) / 1000);
  if (ageSec > TWAP_STALENESS_THRESHOLD_SECONDS) {
    const { data: pep } = await supabase
      .from("peptides")
      .select("code")
      .eq("id", pos.peptide_id)
      .maybeSingle();
    errors.marketDataStale(res, pep?.code ?? "?", ageSec, twap.computed_at);
    return;
  }

  const { data, error } = await supabase.rpc("close_position", {
    p_user_id: user.id,
    p_position_id: positionId,
    p_exit_twap: Number(twap.twap_usd_per_mg),
    p_exit_peptide_twap_id: twap.id,
  });
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("POSITION_NOT_FOUND")) {
      errors.positionNotFound(res);
      return;
    }
    errors.internal(res, `close_position rpc: ${msg}`);
    return;
  }

  const result = data as unknown as {
    position: PositionRow;
    new_balance: number | string;
    realized_pnl_points: number | string;
    idempotent: boolean;
  };

  res.status(200).json({
    position: shapePosition(result.position),
    new_balance: n(result.new_balance)!,
    realized_pnl_points: n(result.realized_pnl_points)!,
    idempotent: result.idempotent,
  });
}

// ─── GET /positions ────────────────────────────────────────────────────────
export async function listPositionsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(req);
  const parsed = listPositionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    errors.invalidInput(res, "status must be open|closed|all");
    return;
  }
  const status = parsed.data.status;

  const supabase = adminClient();
  const query = supabase
    .from("positions")
    .select("*")
    .eq("user_id", user.id)
    .order("opened_at", { ascending: false });
  if (status !== "all") query.eq("status", status);
  const { data, error } = await query;
  if (error) {
    errors.internal(res, `positions list: ${error.message}`);
    return;
  }

  // Live PnL needs current TWAPs for each peptide an open position exists on.
  // Batch the lookup so a 50-position list doesn't fan out into 50 queries.
  const peptideIdsForLive = Array.from(
    new Set((data ?? []).filter((r) => r.status === "open").map((r) => r.peptide_id)),
  );
  const liveTwaps = await batchLatestTwaps(peptideIdsForLive);

  const rows = (data ?? []).map((row) => {
    const shaped = shapePosition(row as PositionRow);
    if (row.status === "open") {
      const twap = liveTwaps.get(row.peptide_id);
      if (twap) {
        const live = computeLivePnL({
          direction: row.direction as "long" | "short",
          entrySize: n(row.entry_size_points)!,
          entryTwap: n(row.entry_twap_usd_per_mg)!,
          currentTwap: twap.twap_usd_per_mg,
        });
        Object.assign(shaped, {
          current_twap_usd_per_mg: twap.twap_usd_per_mg,
          current_twap_age_seconds: Math.floor(
            (Date.now() - new Date(twap.computed_at).getTime()) / 1000,
          ),
          ...live,
        });
      } else {
        Object.assign(shaped, {
          current_twap_usd_per_mg: null,
          current_twap_age_seconds: null,
          pct_change_from_entry: null,
          unrealized_pnl_points: null,
          current_value_points: null,
        });
      }
    }
    return shaped;
  });

  res.json({ positions: rows });
}

async function batchLatestTwaps(
  peptideIds: number[],
): Promise<Map<number, LatestTwapRow>> {
  const out = new Map<number, LatestTwapRow>();
  if (peptideIds.length === 0) return out;
  // PostgREST doesn't have a "DISTINCT ON" primitive — we read recent rows
  // and reduce client-side. With 14 active peptides × 1 row/min ≈ 200 rows
  // in the last 15 minutes, this is cheap.
  const supabase = adminClient();
  const { data, error } = await supabase
    .from("peptide_twaps")
    .select("id, peptide_id, twap_usd_per_mg, computed_at")
    .in("peptide_id", peptideIds)
    .not("twap_usd_per_mg", "is", null)
    .order("computed_at", { ascending: false })
    .limit(peptideIds.length * 5);
  if (error) throw error;
  for (const row of data ?? []) {
    if (out.has(row.peptide_id)) continue;
    out.set(row.peptide_id, {
      id: row.id,
      twap_usd_per_mg: String(row.twap_usd_per_mg),
      computed_at: row.computed_at,
    });
  }
  return out;
}

// ─── GET /positions/:id ────────────────────────────────────────────────────
export async function getPositionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(req);
  const parsed = uuidParamSchema.safeParse(req.params);
  if (!parsed.success) {
    errors.positionNotFound(res); // bad UUID = "not found" to outsiders
    return;
  }
  const positionId = parsed.data.id;

  const supabase = adminClient();
  const { data: row, error } = await supabase
    .from("positions")
    .select("*")
    .eq("id", positionId)
    .maybeSingle();
  if (error) {
    errors.internal(res, `position fetch: ${error.message}`);
    return;
  }
  if (!row || row.user_id !== user.id) {
    errors.positionNotFound(res);
    return;
  }

  const shaped = shapePosition(row as PositionRow);
  if (row.status === "open") {
    const twap = await getLatestTwap(row.peptide_id);
    if (twap) {
      const live = computeLivePnL({
        direction: row.direction as "long" | "short",
        entrySize: n(row.entry_size_points)!,
        entryTwap: n(row.entry_twap_usd_per_mg)!,
        currentTwap: twap.twap_usd_per_mg,
      });
      Object.assign(shaped, {
        current_twap_usd_per_mg: twap.twap_usd_per_mg,
        current_twap_age_seconds: Math.floor(
          (Date.now() - new Date(twap.computed_at).getTime()) / 1000,
        ),
        ...live,
      });
    }
  }

  res.json({ position: shaped });
}
