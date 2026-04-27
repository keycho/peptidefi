"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@peptidefi/db";

/**
 * Browser-side Supabase client. Uses the publishable key only — never the
 * secret key. Reads cookies set by the middleware/server, so client-component
 * code stays in sync with server-component renders.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
