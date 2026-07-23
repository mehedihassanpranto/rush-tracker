import { createBrowserClient } from '@supabase/ssr'
import { getClientEnv } from '@/lib/env/env.public'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Browser Supabase client.
 *
 * Allowed uses: legitimate auth/session flows only (e.g. completing a
 * password-recovery link). All business reads/writes must go through
 * TanStack Start server functions — never query business tables from here.
 */
let browserClient: SupabaseClient | undefined

export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const env = getClientEnv()
    browserClient = createBrowserClient(
      env.VITE_SUPABASE_URL,
      env.VITE_SUPABASE_ANON_KEY,
    )
  }
  return browserClient
}
