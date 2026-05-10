import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@peptide-oracle/db";

/**
 * Service-role Supabase client for backend services (scraper, worker).
 *
 * Reads env at call time (not at module load) so a process can start up,
 * read its .env via dotenv, then create the client — Node's `import` lock
 * order would otherwise miss late-loaded env vars.
 *
 * Auth options are hard-disabled because backend services don't have a user
 * session: persistSession/autoRefreshToken would only write garbage to the
 * filesystem.
 *
 * The client uses SUPABASE_SECRET_KEY which bypasses RLS — it must NEVER be
 * shipped to a browser. Frontend code uses NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 * via a separate factory in apps/web/lib/supabase/.
 */
export type AdminClient = SupabaseClient<Database>;

export function createAdminClient(): AdminClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url) {
    throw new Error(
      "createAdminClient: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is not set",
    );
  }
  if (!key) {
    throw new Error("createAdminClient: SUPABASE_SECRET_KEY is not set");
  }

  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { "x-peptide-oracle-service": "admin" },
    },
  });
}

/**
 * Untyped variant — same client, but with the Database schema-type
 * stripped. Use this for tables / columns that exist in the schema
 * but not yet in the generated `@peptide-oracle/db` types (e.g. a
 * recently-added column whose types haven't been regenerated).
 *
 * Mirrors apps/api/src/supabase.ts::adminClientUntyped() — same
 * rationale, same one-call-site footprint per new feature. Once
 * Database types catch up, callers can switch to createAdminClient()
 * and lose no functionality.
 */
export function createAdminClientUntyped(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}
