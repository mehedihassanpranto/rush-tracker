import { createClient } from '@supabase/supabase-js'
import { createServerOnlyFn } from '@tanstack/react-start'
import { getServerEnv } from '@/lib/env/env.server'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Privileged admin Supabase client — SERVER ONLY.
 *
 * Uses the service-role key and BYPASSES Row Level Security. Only call this
 * from server-side code, after the caller has already been authenticated and
 * authorized. `createServerOnlyFn` guarantees a runtime error if this module
 * is ever invoked from the browser bundle.
 */
let adminClient: SupabaseClient | undefined

export const getSupabaseAdminClient = createServerOnlyFn(
  (): SupabaseClient => {
    if (!adminClient) {
      const env = getServerEnv()
      adminClient = createClient(
        env.SUPABASE_URL,
        env.SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        },
      )
    }
    return adminClient
  },
)
