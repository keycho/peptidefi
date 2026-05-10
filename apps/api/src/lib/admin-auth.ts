import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Admin auth middleware for /api/admin/*. Reads a static bearer
 * token from the env var ADMIN_API_TOKEN and compares (constant-time)
 * with the request's `Authorization: Bearer <token>` header.
 *
 * Why a separate token vs reusing SUPABASE_SECRET_KEY: scope
 * separation. The SB key is the database master credential —
 * leaking it via the admin surface would also leak the database. A
 * dedicated ADMIN_API_TOKEN can be rotated independently and
 * audited via /api/anomalies.
 *
 * If ADMIN_API_TOKEN is unset, the middleware fails closed (refuses
 * every request with 503). That prevents an "I forgot to set the
 * env var" deploy from accidentally exposing the admin surface
 * unauthenticated.
 */
export function requireAdminToken(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req, res, next) => {
    const expected = process.env.ADMIN_API_TOKEN;
    if (!expected || expected.length < 16) {
      res.status(503).json({
        code: "ADMIN_TOKEN_NOT_CONFIGURED",
        message:
          "ADMIN_API_TOKEN env var must be set (>=16 chars) for the admin surface to function",
      });
      return;
    }
    const header = req.header("authorization") ?? "";
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      res
        .status(401)
        .json({ code: "MISSING_BEARER", message: "Authorization: Bearer <token> required" });
      return;
    }
    const presented = m[1]!.trim();
    // Constant-time compare. Pad both to equal length so
    // timingSafeEqual doesn't throw on length mismatch (which would
    // itself leak length). Use a sentinel byte that can't appear in
    // a normal token to guarantee mismatch on length differences.
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    const max = Math.max(a.length, b.length);
    const aPad = Buffer.alloc(max, 0);
    const bPad = Buffer.alloc(max, 0);
    a.copy(aPad);
    b.copy(bPad);
    const equal = a.length === b.length && timingSafeEqual(aPad, bPad);
    if (!equal) {
      res
        .status(403)
        .json({ code: "BAD_BEARER", message: "invalid admin token" });
      return;
    }
    next();
  };
}
