"use server";

import { redirect } from "next/navigation";
import { signupSchema } from "@peptidefi/shared";
import { createClient } from "@/lib/supabase/server";
import type { AuthState } from "@/app/login/actions";

/**
 * Email + password signup. With mailer_autoconfirm enabled on the Supabase
 * project (Phase A only), Supabase auto-confirms the email and returns an
 * active session, so we can redirect straight to the home page.
 *
 * The handle_new_auth_user() trigger atomically creates the public.users row,
 * the 10,000-point signup grant, the ledger entry, and the balance cache.
 */
export async function signupAction(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = createClient();
  const { error } = await supabase.auth.signUp(parsed.data);
  if (error) return { error: error.message };

  redirect("/");
}
