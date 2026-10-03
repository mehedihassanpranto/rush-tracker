import { getRequestHeader, getRequestIP } from '@tanstack/react-start/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { getServerEnv } from '@/lib/env/env.server'
import {
  checkRateLimit,
  rateLimitMessage,
  recordAttempt,
} from '@/server/auth/rate-limit.service'
import { clientIpFrom } from '@/lib/auth/rate-limit'

/**
 * Server-only helpers shared by the account-security fns (mfa.fns.ts,
 * email-change.fns.ts). A plain module, not a .fns.ts export, so a second
 * .fns.ts file importing it can't drag server code into the client bundle.
 * Call only from inside server-fn handler bodies.
 */

export function requestIp(): string | null {
  return clientIpFrom(getRequestHeader('x-forwarded-for'), getRequestIP() ?? null)
}

/**
 * Re-check the signed-in user's password before a sensitive change (a stolen,
 * still-open session must not be enough to take the account over). Checked on
 * a throwaway client so this session's cookies are untouched; counts toward
 * the sign-in rate limit.
 */
export async function assertCurrentPassword(email: string, password: string): Promise<void> {
  const admin = getSupabaseAdminClient()
  const ip = requestIp()
  const limit = await checkRateLimit(admin, 'login', email, ip)
  if (!limit.allowed) throw new Error(rateLimitMessage(limit.retryAfterMinutes))

  const env = getServerEnv()
  const probe = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await probe.auth.signInWithPassword({ email, password })
  await recordAttempt(admin, 'login', email, ip, !error)
  if (error) throw new Error('Your current password is not correct.')
  // End only that throwaway session, not the user's other sessions.
  await probe.auth.signOut({ scope: 'local' })
}
