import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookiesToSet = { name: string; value: string; options: CookieOptions }[];
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@peptidefi/db";

/**
 * Per-request session refresh + auth gate.
 *
 * The Supabase JWT is short-lived; this helper, called from middleware.ts on
 * every request, transparently refreshes the access token by reading and
 * rewriting the auth cookie. The request and response cookie jars are kept
 * in sync so downstream Server Components see the refreshed session.
 *
 * Auth gate: any path outside the PUBLIC_PATHS set requires a logged-in user.
 * Unauthenticated visitors get a 302 to /login. Logged-in users hitting
 * /login or /signup get bounced to /.
 */
const PUBLIC_PATHS = ["/login", "/signup", "/auth/callback"];

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
  const isPublic = PUBLIC_PATHS.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
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
