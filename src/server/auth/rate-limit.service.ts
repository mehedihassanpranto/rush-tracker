import type { SupabaseClient } from '@supabase/supabase-js'
import { RATE_LIMITS, normalizeIdentifier, rateLimitDecision } from '@/lib/auth/rate-limit'
import type { AttemptKind } from '@/lib/auth/rate-limit'

/**
 * Database-backed rate limiting for sign-in, 2FA codes and reset emails
 * (auth_attempts, migration 000055). Stored in Postgres rather than process
 * memory so it holds across restarts and multiple app instances.
 *
 * Availability over strictness on infrastructure failure: if the attempts
 * table can't be read, the request is ALLOWED (and logged) — a database blip
 * must not lock every user out. Supabase Auth's own limits still apply then.
 */

export async function checkRateLimit(
  admin: SupabaseClient,
  kind: AttemptKind,
  identifier: string,
  ip: string | null,
): Promise<{ allowed: true } | { allowed: false; retryAfterMinutes: number }> {
  const limit = RATE_LIMITS[kind]
  const since = new Date(Date.now() - limit.windowMinutes * 60_000).toISOString()
  const id = normalizeIdentifier(identifier)
  try {
    const base = () => {
      let q = admin
        .from('auth_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('kind', kind)
        .gte('attempted_at', since)
      if (!limit.countAll) q = q.eq('success', false)
      return q
    }
    const [byId, byIp] = await Promise.all([
      base().eq('identifier', id),
      ip ? base().eq('ip', ip) : Promise.resolve({ count: 0, error: null }),
    ])
    if (byId.error) throw byId.error
    if (byIp.error) throw byIp.error
    return rateLimitDecision(kind, { identifier: byId.count ?? 0, ip: byIp.count ?? 0 })
  } catch (err) {
    console.error('[rate-limit] check failed, allowing', err)
    return { allowed: true }
  }
}

export async function recordAttempt(
  admin: SupabaseClient,
  kind: AttemptKind,
  identifier: string,
  ip: string | null,
  success: boolean,
): Promise<void> {
  try {
    const { error } = await admin
      .from('auth_attempts')
      .insert({ kind, identifier: normalizeIdentifier(identifier), ip, success })
    if (error) throw error
  } catch (err) {
    console.error('[rate-limit] could not record attempt', err)
  }
}

export function rateLimitMessage(minutes: number): string {
  return `Too many attempts. Please wait ${minutes} minutes and try again.`
}
