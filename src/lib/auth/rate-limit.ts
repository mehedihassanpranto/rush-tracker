/**
 * Sign-in / 2FA / password-reset rate limits. Pure (no server imports) so the
 * numbers and the decision are unit-tested directly.
 *
 * Per-ACCOUNT limits are the real protection: they can't be dodged by
 * rotating IPs or forging headers. Per-IP limits catch one source spraying
 * many accounts. A successful sign-in doesn't reset the counter — the window
 * simply slides — which keeps the logic trivial and still never locks out
 * someone who types their password right.
 */

export type AttemptKind = 'login' | 'mfa' | 'reset'

export interface RateLimit {
  windowMinutes: number
  /** failed attempts (login/mfa) or requests (reset) allowed per account */
  perIdentifier: number
  /** same, per client IP */
  perIp: number
  /** reset counts every request, not just failures (emails cost something) */
  countAll: boolean
}

export const RATE_LIMITS: Record<AttemptKind, RateLimit> = {
  login: { windowMinutes: 15, perIdentifier: 5, perIp: 30, countAll: false },
  mfa: { windowMinutes: 15, perIdentifier: 5, perIp: 30, countAll: false },
  reset: { windowMinutes: 60, perIdentifier: 3, perIp: 10, countAll: true },
}

export function rateLimitDecision(
  kind: AttemptKind,
  counts: { identifier: number; ip: number },
): { allowed: true } | { allowed: false; retryAfterMinutes: number } {
  const l = RATE_LIMITS[kind]
  if (counts.identifier >= l.perIdentifier || counts.ip >= l.perIp) {
    return { allowed: false, retryAfterMinutes: l.windowMinutes }
  }
  return { allowed: true }
}

/**
 * The client's IP from an X-Forwarded-For chain. The LAST entry is the one the
 * nearest (trusted) proxy appended; earlier entries are whatever the client
 * sent and can be forged.
 */
export function clientIpFrom(forwardedFor: string | null | undefined, fallback: string | null): string | null {
  if (forwardedFor) {
    const parts = forwardedFor.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return fallback
}

export function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase()
}
