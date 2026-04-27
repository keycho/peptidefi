import type { Request, Response, NextFunction } from "express";
import { errors as joseErrors, jwtVerify } from "jose";

/**
 * Local JWT verification middleware.
 *
 * Supabase signs user access tokens with the project's HS256 JWT secret
 * (Project Settings → API → "JWT Secret"). We verify the signature
 * against that secret using `jose` — purely local crypto, no network
 * round-trip per request, no DB lookup. The verified `sub` claim is the
 * Supabase user id, which is the same UUID stored in
 * public.users.id and used everywhere downstream.
 *
 * On success, attaches `req.user = { id, email? }`. On failure, responds
 * 401 with a stable error code so the frontend can distinguish missing
 * vs. expired vs. malformed.
 *
 * Error codes:
 *   AUTH_MISSING        no Authorization header
 *   AUTH_BAD_FORMAT     header present but not "Bearer <token>"
 *   AUTH_EXPIRED        signature valid but exp claim in the past
 *   AUTH_INVALID        signature mismatch / bad audience / bad issuer
 *   AUTH_INTERNAL       server-side misconfig (no JWT secret)
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email?: string };
    }
  }
}

let cachedSecret: Uint8Array | null = null;
function jwtSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const raw = process.env.SUPABASE_JWT_SECRET;
  if (!raw) {
    throw new Error("authRequired: SUPABASE_JWT_SECRET is not set");
  }
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

export async function authRequired(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header) {
    res.status(401).json({ code: "AUTH_MISSING", message: "Authorization header required" });
    return;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    res.status(401).json({
      code: "AUTH_BAD_FORMAT",
      message: 'Authorization header must be "Bearer <token>"',
    });
    return;
  }
  const token = match[1]!.trim();

  let secret: Uint8Array;
  try {
    secret = jwtSecret();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ code: "AUTH_INTERNAL", message: msg });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, secret, {
      // Supabase Auth signs user tokens with audience="authenticated".
      audience: "authenticated",
    });
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (!sub) {
      res.status(401).json({ code: "AUTH_INVALID", message: "Token missing sub claim" });
      return;
    }
    req.user = {
      id: sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
    next();
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      res.status(401).json({ code: "AUTH_EXPIRED", message: "Token has expired" });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(401).json({ code: "AUTH_INVALID", message: msg });
    return;
  }
}

/**
 * Convenience for route handlers: throws if req.user is missing.
 * Combine with authRequired upstream so this never actually throws.
 */
export function requireUser(req: Request): { id: string; email?: string } {
  if (!req.user) {
    throw new Error("requireUser: route is not behind authRequired middleware");
  }
  return req.user;
}
