import { createServerClient, type CookieOptions } from "@supabase/ssr";

import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@peptidefi/db";

type CookiesToSet = { name: string; value: string; options: CookieOptions }[];

/**
 * Per-request session refresh + auth gate.
 *
 * The product is public-by-default, gated-on-action (Hyperliquid /
 * Polymarket / Uniswap pattern). Anyone can browse the storefront —
 * prices, charts, AMM screens, prediction markets, leaderboard — without
 * a session. Login is only required for routes that read a user's
 * personal state (portfolio, account) or that mutate it (trade APIs).
 *
 * Auth flow: this helper is called from middleware.ts on every matched
 * request. It refreshes the Supabase access token (via getUser, which
 * reads + rewrites the auth cookie). The request and response cookie
 * jars are kept in sync so downstream Server Components see the
 * refreshed session.
 *
 * Gating rules:
 *   - DENY_PREFIXES require an authenticated session; logged-out
 *     visitors are redirected to /login?next=<path>.
 *   - /login and /signup bounce already-logged-in users to /.
 *   - Everything else is public — anonymous visitors flow through
 *     untouched.
 *
 * Add new private routes by appending to DENY_PREFIXES. API routes
 * that mutate user state should also enforce the session check at the
 * handler level (defense in depth).
 */
const DENY_PREFIXES = ["/portfolio", "/account"];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // IMPORTANT: do not run any code between createServerClient and getUser().
  // getUser() is what triggers the cookie refresh.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPrivate = DENY_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );

  if (!user && isPrivate) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(url);
  }

  if (user && (path === "/login" || path === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
