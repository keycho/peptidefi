import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@peptidefi/db";

/**
 * Service-role Supabase client used by the API for trusted server-side
 * reads/writes (point_balances, positions, etc.). Bypasses RLS — never
 * shipped to the browser, never instantiated outside this process.
 *
 * This is a thin wrapper rather than reusing
 * @peptidefi/shared/supabase-admin so the API can keep its own client
 * lifecycle (e.g. swap to a per-request client later if we add request
 * tracing or per-user auth-context propagation).
 */
export type AdminClient = SupabaseClient<Database>;

let _admin: AdminClient | null = null;

export function adminClient(): AdminClient {
  if (_admin) return _admin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url) throw new Error("adminClient: SUPABASE_URL is not set");
  if (!key) throw new Error("adminClient: SUPABASE_SECRET_KEY is not set");
  _admin = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-peptidefi-service": "api" } },
  });
  return _admin;
}
