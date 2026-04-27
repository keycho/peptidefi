import type { Request, Response, NextFunction } from "express";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

/**
 * Local JWT verification middleware (asymmetric ES256 via JWKS).
 *
 * Modern Supabase projects sign user access tokens with an asymmetric
 * ES256 key (ECC P-256). The matching public key is published at
 *   <SUPABASE_URL>/auth/v1/.well-known/jwks.json
 * — a CORS-friendly, unauthenticated endpoint that exposes the JWK set
 * with a stable `kid` per key.
 *
 * We use jose's `createRemoteJWKSet` helper, which:
 *   - Fetches the JWKS lazily on first verify call.
 *   - Caches the key set for 10 minutes (jose default
 *     `cacheMaxAge: 600_000`).
 *   - Re-fetches on `kid` mismatch, but no more than once every 30s
 *     (jose default `cooldownDuration: 30_000`) to prevent thundering
 *     herd against Supabase Auth.
 *   - Refresh failures fall through as verification errors — we map
 *     those to AUTH_INVALID so the auth path degrades to "deny" rather
 *     than "allow" if Supabase Auth is unreachable.
 *
 * We keep jose's defaults; bumping cacheMaxAge would risk holding stale
 * keys past a Supabase rotation, and tightening cooldownDuration would
 * make the auth endpoint a fast-path attack surface for Supabase Auth.
 *
 * Verification claims enforced:
 *   - signature      against the matching JWK from the cached set
 *   - alg            must be ES256 (rejects HS256 'alg confusion' attacks
 *                    if Supabase ever issues a mixed-key project)
 *   - audience       must be 'authenticated' (Supabase user tokens)
 *   - issuer         must be `${SUPABASE_URL}/auth/v1` (prevents tokens
 *                    minted by a *different* Supabase project from
 *                    passing if both happen to share a JWKS host pattern)
 *   - exp            jose's jwtVerify enforces the standard exp/nbf claims
 *
 * On success: req.user = { id: payload.sub, email?: payload.email }.
 * On failure: 401 with a stable error code so the frontend can branch
 * without parsing message text.
 *
 * Error codes:
 *   AUTH_MISSING        no Authorization header
 *   AUTH_BAD_FORMAT     header present but not "Bearer <token>"
 *   AUTH_EXPIRED        signature valid but exp claim in the past
 *   AUTH_INVALID        signature mismatch / bad audience / bad issuer
 *                        / JWKS fetch failed / unknown kid past cooldown
 *   AUTH_INTERNAL       server-side misconfig (SUPABASE_URL missing)
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email?: string };
    }
  }
}

let cachedJwks: JWTVerifyGetKey | null = null;
let cachedIssuer: string | null = null;

function getJwksAndIssuer(): { jwks: JWTVerifyGetKey; issuer: string } {
  if (cachedJwks && cachedIssuer) {
    return { jwks: cachedJwks, issuer: cachedIssuer };
  }
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error("authRequired: SUPABASE_URL is not set");
  }
  const trimmed = url.replace(/\/+$/, "");
  cachedJwks = createRemoteJWKSet(
    new URL(`${trimmed}/auth/v1/.well-known/jwks.json`),
  );
  cachedIssuer = `${trimmed}/auth/v1`;
  return { jwks: cachedJwks, issuer: cachedIssuer };
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

  let jwks: JWTVerifyGetKey;
  let issuer: string;
  try {
    ({ jwks, issuer } = getJwksAndIssuer());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ code: "AUTH_INTERNAL", message: msg });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["ES256"],
      audience: "authenticated",
      issuer,
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
