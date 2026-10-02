import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { checkMetaToken } from '@/server/meta/meta.server'
import { notifyAdmins, notifyPlatformAdmins } from '@/server/notifications/notification.service'
import { notifyTelegram } from '@/server/telegram/telegram.service'
import {
  PLATFORM_CREDENTIALS,
  credentialScopeKey,
  organizationCredentials,
} from '@/lib/meta/credential-scope'
import { tokenState } from '@/lib/monitoring/health'
import type { TokenState } from '@/lib/monitoring/health'
import type { MetaCredentialScope } from '@/lib/meta/credential-scope'

/**
 * Health checks run by the daily cron (and on demand from Platform → System
 * health). Alerts fire once per change of state — a token that stays broken
 * doesn't page anyone every day — tracked in integration_health.alerted_state.
 */

export interface TokenCheckResult {
  scope_key: string
  label: string
  state: TokenState
  error: string | null
  alerted: boolean
}

const ALERT_STATES: ReadonlyArray<TokenState> = ['invalid', 'expiring']

/** Every credential set that exists: the platform's, plus each active agency
 * that connected its own Business Portfolio. */
async function credentialSets(): Promise<
  Array<{ scope: MetaCredentialScope; label: string; organizationId: string | null }>
> {
  const admin = getSupabaseAdminClient()
  const sets: Array<{ scope: MetaCredentialScope; label: string; organizationId: string | null }> = [
    { scope: PLATFORM_CREDENTIALS, label: 'Platform (ad account pool)', organizationId: null },
  ]
  const { data: rows } = await admin
    .from('app_settings')
    .select('organization_id, organization:organizations(name, subscription_status)')
    .eq('key', 'META_SYSTEM_USER_TOKEN')
  for (const r of (rows ?? []) as unknown as Array<{
    organization_id: string
    organization: { name: string; subscription_status: string } | null
  }>) {
    if (r.organization?.subscription_status !== 'active') continue
    sets.push({
      scope: organizationCredentials(r.organization_id),
      label: r.organization.name,
      organizationId: r.organization_id,
    })
  }
  return sets
}

export async function runMetaTokenChecks(): Promise<Array<TokenCheckResult>> {
  const admin = getSupabaseAdminClient()
  const results: Array<TokenCheckResult> = []

  for (const set of await credentialSets()) {
    const key = credentialScopeKey(set.scope)
    const health = await checkMetaToken(set.scope)
    const state = tokenState(health)

    const { data: prev } = await admin
      .from('integration_health')
      .select('alerted_state')
      .eq('scope_key', key)
      .maybeSingle()
    const prevAlerted = (prev as { alerted_state: string | null } | null)?.alerted_state ?? null
    // 'unknown' (couldn't reach Meta) neither alerts nor clears a previous alert.
    const nextAlerted = state === 'unknown' ? prevAlerted : state
    const shouldAlert = ALERT_STATES.includes(state) && prevAlerted !== state

    await admin.from('integration_health').upsert({
      scope_key: key,
      provider: 'meta',
      checked_at: new Date().toISOString(),
      configured: health.configured,
      valid: health.valid,
      expires_at: health.expiresAt,
      data_access_expires_at: health.dataAccessExpiresAt,
      error: health.error,
      alerted_state: nextAlerted,
    })

    if (shouldAlert) {
      const title =
        state === 'invalid'
          ? `Meta token not working — ${set.label}`
          : `Meta token expires soon — ${set.label}`
      const when = health.expiresAt ?? health.dataAccessExpiresAt
      const message =
        state === 'invalid'
          ? `Meta rejected the System User token${health.error ? `: ${health.error}` : ''}. Live Meta data, spend-cap sync and imports stop until a new token is saved in Settings → Meta integration.`
          : `The System User token${when ? ` expires on ${when.slice(0, 10)}` : ' expires within 7 days'}. Generate a new one in Meta Business Settings and save it in Settings → Meta integration.`
      if (set.organizationId) {
        await notifyAdmins({ organizationId: set.organizationId, type: 'META_TOKEN', title, message })
        await notifyTelegram({
          eventType: 'meta.token_problem',
          recipient: { type: 'agency', organizationId: set.organizationId },
          text: `⚠️ ${title}\n${message}`,
          payload: { scope_key: key, state },
        })
      } else {
        await notifyPlatformAdmins({ type: 'META_TOKEN', title, message })
        await notifyTelegram({
          eventType: 'meta.token_problem',
          recipient: { type: 'platform_admin' },
          text: `⚠️ ${title}\n${message}`,
          payload: { scope_key: key, state },
        })
      }
    }

    results.push({ scope_key: key, label: set.label, state, error: health.error, alerted: shouldAlert })
  }
  return results
}

/** Count of server errors in the last 24h, sent to platform admins when > 0. */
export async function sendErrorDigest(): Promise<{ count: number }> {
  const admin = getSupabaseAdminClient()
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const { data, count } = await admin
    .from('app_errors')
    .select('message', { count: 'exact' })
    .gte('occurred_at', since)
    .limit(500)
  const total = count ?? 0
  if (total === 0) return { count: 0 }

  const byMessage = new Map<string, number>()
  for (const r of data ?? []) {
    const m = (r.message as string).slice(0, 120)
    byMessage.set(m, (byMessage.get(m) ?? 0) + 1)
  }
  const top = [...byMessage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const title = `${total} server error${total === 1 ? '' : 's'} in the last 24 hours`
  const message = top.map(([m, n]) => `${n}× ${m}`).join('\n')
  await notifyPlatformAdmins({ type: 'SYSTEM_ERRORS', title, message })
  await notifyTelegram({
    eventType: 'system.errors_digest',
    recipient: { type: 'platform_admin' },
    text: `🧯 ${title}\n${message}\nDetails: Platform → System health`,
    payload: { count: total },
  })
  return { count: total }
}

export async function alertCronFailure(job: string, status: 'partial' | 'failed', detail: string) {
  const title = `Background job ${status === 'failed' ? 'failed' : 'partly failed'}: ${job}`
  await notifyPlatformAdmins({ type: 'CRON_FAILED', title, message: detail })
  await notifyTelegram({
    eventType: 'system.cron_failed',
    recipient: { type: 'platform_admin' },
    text: `🚨 ${title}\n${detail}`,
    payload: { job, status },
  })
}
