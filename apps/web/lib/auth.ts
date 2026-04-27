import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Returns the signed-in user, or null. Use this in public-by-default pages
 * that want to render different UI for guests vs members (e.g. show a
 * "Sign in" button vs a "Sign out" button in the header).
 *
 * Calls supabase.auth.getUser() which validates the JWT against Supabase
 * Auth — do not be tempted to short-circuit by reading getSession() locally,
 * since that returns the unvalidated cookie payload.
 */
export async function getOptionalUser(): Promise<User | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Returns the signed-in user, or redirects to /login (preserving the current
 * path in ?next=). Use this in private pages and route handlers that read or
 * mutate the calling user's state.
 *
 * Defense-in-depth: middleware also gates DENY_PREFIXES routes, but private
 * pages call this helper directly so an accidental middleware bypass cannot
 * leak data.
 */
export async function getRequiredUser(opts?: {
  redirectTo?: string;
}): Promise<User> {
  const user = await getOptionalUser();
  if (!user) {
    const next = opts?.redirectTo ? `?next=${encodeURIComponent(opts.redirectTo)}` : "";
    redirect(`/login${next}`);
  }
  return user;
}
