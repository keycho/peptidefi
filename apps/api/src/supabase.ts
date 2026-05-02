import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@peptide-oracle/db";

/**
 * Service-role Supabase client used by the API for trusted server-side
 * reads/writes (point_balances, positions, etc.). Bypasses RLS — never
 * shipped to the browser, never instantiated outside this process.
 *
 * This is a thin wrapper rather than reusing
 * @peptide-oracle/shared/supabase-admin so the API can keep its own client
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
    global: { headers: { "x-peptide-oracle-service": "api" } },
  });
  return _admin;
}

/**
 * Untyped variant of adminClient() — same client, but with the
 * Database schema-type stripped. Used by the §05 verification
 * routes that read from commit_cycles, commit_observations, and
 * twap_commits — tables added in migrations 0031/0032 that aren't
 * yet in the @peptide-oracle/db generated types.
 *
 * The narrow row shapes consumed by those routes are declared
 * inline in each route file, so the untyped client doesn't widen
 * the surface beyond a single .from() call site.
 *
 * Once the Database types are regenerated to include these tables,
 * this helper goes away and the routes switch to adminClient().
 */
export function adminClientUntyped(): SupabaseClient {
  return adminClient() as unknown as SupabaseClient;
}
