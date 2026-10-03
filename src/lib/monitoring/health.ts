/**
 * Monitoring rules shared by the cron (alerting) and the System Health page.
 * Pure — no database, no server imports.
 */

/** The Meta sync runs daily; a little slack for a late cron before "stale". */
export const CRON_STALE_HOURS = 26

/** Alert this many days before a Meta token (or its data access) expires. */
export const TOKEN_EXPIRY_WARN_DAYS = 7

export type CronFreshness = 'ok' | 'stale' | 'never'

export function cronFreshness(lastSuccessAt: string | null, now: Date = new Date()): CronFreshness {
  if (!lastSuccessAt) return 'never'
  const ageHours = (now.getTime() - new Date(lastSuccessAt).getTime()) / 3_600_000
  return ageHours > CRON_STALE_HOURS ? 'stale' : 'ok'
}

export type TokenState = 'not_configured' | 'ok' | 'expiring' | 'invalid' | 'unknown'

/**
 * `expiresAt`/`dataAccessExpiresAt` null = never (Meta reports 0 for system
 * user tokens that don't expire). Either expiry inside the warning window
 * counts: a token whose data access lapses stops returning data even though
 * the token itself is still "valid".
 */
export function tokenState(
  h: {
    configured: boolean
    valid: boolean | null
    expiresAt: string | null
    dataAccessExpiresAt: string | null
  },
  now: Date = new Date(),
): TokenState {
  if (!h.configured) return 'not_configured'
  if (h.valid === false) return 'invalid'
  const limit = now.getTime() + TOKEN_EXPIRY_WARN_DAYS * 86_400_000
  for (const t of [h.expiresAt, h.dataAccessExpiresAt]) {
    if (!t) continue
    const at = new Date(t).getTime()
    if (at <= now.getTime()) return 'invalid'
    if (at <= limit) return 'expiring'
  }
  // valid === null: the check couldn't reach Meta — not a verdict.
  return h.valid === null ? 'unknown' : 'ok'
}

/** Meta reports expiry as unix seconds; 0 means it doesn't expire. */
export function unixToIso(seconds: number | null | undefined): string | null {
  if (!seconds) return null
  return new Date(seconds * 1000).toISOString()
}

/**
 * Errors that are part of normal operation and would only drown real bugs in
 * the error log: not signed in / not allowed, plan limits, input validation,
 * Meta simply not connected, and the router's own redirect/notFound control
 * flow (thrown objects, not failures).
 */
const EXPECTED_ERROR_NAMES = new Set([
  'AuthError',
  'PlanLimitError',
  'ZodError',
  'MetaNotConfiguredError',
  'UserError',
])

export function isExpectedError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  if (err instanceof Response) return true
  const e = err as { name?: unknown; isRedirect?: unknown; isNotFound?: unknown }
  if (e.isRedirect === true || e.isNotFound === true) return true
  return typeof e.name === 'string' && EXPECTED_ERROR_NAMES.has(e.name)
}
