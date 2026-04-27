"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { loginSchema } from "@peptidefi/shared";
import { createClient } from "@/lib/supabase/server";

export type AuthState = { error: string | null };

/**
 * Email + password login. Re-validates with Zod (never trust the client).
 * On success, the Supabase session cookie is written by the server client
 * and we redirect to the post-login destination (?next= param or "/").
 */
export async function loginAction(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: error.message };

  const next = (formData.get("next") as string) || "/";
  redirect(next.startsWith("/") ? next : "/");
}

/**
 * Kicks off Google OAuth. Returns a redirect URL that the client navigates
 * to (Supabase requires the redirect to happen from the browser, not the
 * server, so we return the URL rather than calling redirect() here).
 */
export async function googleSignInAction(): Promise<AuthState & { url?: string }> {
  const supabase = createClient();
  const origin = headers().get("origin") ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error) return { error: error.message };
  return { error: null, url: data.url };
}
