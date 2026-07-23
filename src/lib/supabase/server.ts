import { createServerClient } from '@supabase/ssr'
import {
  deleteCookie,
  getCookies,
  setCookie,
} from '@tanstack/react-start/server'
import { getServerEnv } from '@/lib/env/env.server'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * User-scoped server Supabase client for the current request.
 *
 * Reads the Supabase auth session from request cookies and writes refreshed
 * tokens back to response cookies. Operates under the anon key, so RLS
 * applies with the calling user's identity — use this for user-scoped reads
 * and auth operations inside server functions.
 *
 * Must be called within a server request context (server function / loader).
 */
export function getSupabaseServerClient(): SupabaseClient {
  const env = getServerEnv()

  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return Object.entries(getCookies()).map(([name, value]) => ({
          name,
          value,
        }))
      },
      setAll(cookies) {
        for (const cookie of cookies) {
          const options = cookie.options as Parameters<typeof setCookie>[2]
          if (cookie.value === '') {
            deleteCookie(cookie.name, options)
          } else {
            setCookie(cookie.name, cookie.value, options)
          }
        }
      },
    },
  })
}
