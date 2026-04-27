import type { Request, Response } from "express";
import { adminClient } from "../supabase";
import { requireUser } from "../auth";

/**
 * GET /balance — return the calling user's points balance.
 *
 * Auth: req.user.id is set upstream by authRequired middleware. user_id
 * NEVER comes from the request body or query — only the verified JWT sub.
 *
 * The point_balances row is created by the handle_new_auth_user() trigger
 * (migration 0003) at signup, so any authenticated user has exactly one
 * row. If somehow missing, we return 0 with last_updated_at=null rather
 * than 404 — Lovable can show "0 points" without a special-case branch.
 *
 * balance is a numeric(20,6) — returned here as a decimal STRING to
 * match the rest of the codebase's convention (see shared/numeric.ts).
 * Lovable can `parseFloat` if it just needs to display "10000.00 pts" —
 * the values fit comfortably in a JS Number.
 */
export async function balanceHandler(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const supabase = adminClient();

  const { data, error } = await supabase
    .from("point_balances")
    .select("balance, last_updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ code: "DB_ERROR", message: error.message });
    return;
  }
  if (!data) {
    res.json({ user_id: user.id, balance: "0", last_updated_at: null });
    return;
  }
  res.json({
    user_id: user.id,
    balance: String(data.balance),
    last_updated_at: data.last_updated_at,
  });
}
