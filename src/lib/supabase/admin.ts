import "server-only";

// ⚠️ SERVER-ONLY — DO NOT IMPORT INTO CLIENT/BROWSER CODE ⚠️
//
// This client is built with the SUPABASE_SERVICE_ROLE_KEY, which BYPASSES
// Row Level Security entirely. It has full read/write access to every row in
// every table, ignoring all RLS policies.
//
// Only use it in trusted server-side contexts (e.g. webhook handlers, route
// handlers, server-side jobs) where the caller has already been authorized.
// Never import this file into a Client Component, and never expose the
// service_role key to the browser — leaking it grants full database access.

import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
