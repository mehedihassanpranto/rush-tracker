import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { runMetaTokenChecks } from '@/server/monitoring/health-check.server'
import { cronFreshness, tokenState } from '@/lib/monitoring/health'
import type { CronFreshness, TokenState } from '@/lib/monitoring/health'

/**
 * Platform → System health. requirePlatformAdmin; the monitoring tables have
 * zero RLS policies, so this is the only way to read them.
 */

export interface SystemHealth {
  cron: {
    job: string
    freshness: CronFreshness
    last_success_at: string | null
    last_run: {
      started_at: string
      finished_at: string | null
      status: string
      error: string | null
      trigger: { host: string | null; user_agent: string | null } | null
    } | null
    recent: Array<{ started_at: string; status: string; host: string | null }>
  }
  tokens: Array<{
    scope_key: string
    label: string
    state: TokenState
    checked_at: string
    expires_at: string | null
    data_access_expires_at: string | null
    error: string | null
  }>
  errors: {
    last_24h: number
    last_7d: number
    groups: Array<{ message: string; fn_name: string | null; count: number; last_seen: string }>
  }
}

export const getSystemHealthFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SystemHealth> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const job = 'meta-sync'
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString()

    const [runs, lastSuccess, health, orgs, errs] = await Promise.all([
      admin.from('cron_runs').select('*').eq('job', job).order('started_at', { ascending: false }).limit(10),
      admin
        .from('cron_runs')
        .select('finished_at')
        .eq('job', job)
        .eq('status', 'success')
        .order('finished_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin.from('integration_health').select('*').order('scope_key'),
      admin.from('organizations').select('id, name'),
      admin
        .from('app_errors')
        .select('message, fn_name, occurred_at')
        .gte('occurred_at', weekAgo)
        .order('occurred_at', { ascending: false })
        .limit(1000),
    ])
    for (const r of [runs, health, orgs, errs]) if (r.error) throw new Error(r.error.message)

    const runRows = (runs.data ?? []) as Array<{
      started_at: string
      finished_at: string | null
      status: string
      error: string | null
      summary: { trigger?: { host: string | null; user_agent: string | null } } | null
    }>
    const lastSuccessAt =
      (lastSuccess.data as { finished_at: string | null } | null)?.finished_at ?? null
    const orgName = new Map((orgs.data ?? []).map((o) => [`org:${o.id}`, o.name as string]))

    const groups = new Map<string, { message: string; fn_name: string | null; count: number; last_seen: string }>()
    let last24 = 0
    for (const e of (errs.data ?? []) as Array<{ message: string; fn_name: string | null; occurred_at: string }>) {
      if (e.occurred_at >= dayAgo) last24++
      const key = `${e.fn_name ?? ''}|${e.message}`
      const g = groups.get(key)
      if (g) g.count++
      else groups.set(key, { message: e.message, fn_name: e.fn_name, count: 1, last_seen: e.occurred_at })
    }

    return {
      cron: {
        job,
        freshness: cronFreshness(lastSuccessAt),
        last_success_at: lastSuccessAt,
        last_run: runRows[0]
          ? {
              started_at: runRows[0].started_at,
              finished_at: runRows[0].finished_at,
              status: runRows[0].status,
              error: runRows[0].error,
              trigger: runRows[0].summary?.trigger ?? null,
            }
          : null,
        recent: runRows.map((r) => ({
          started_at: r.started_at,
          status: r.status,
          host: r.summary?.trigger?.host ?? null,
        })),
      },
      tokens: ((health.data ?? []) as Array<{
        scope_key: string
        checked_at: string
        configured: boolean
        valid: boolean | null
        expires_at: string | null
        data_access_expires_at: string | null
        error: string | null
      }>).map((h) => ({
        scope_key: h.scope_key,
        label: h.scope_key === 'platform' ? 'Platform (ad account pool)' : (orgName.get(h.scope_key) ?? h.scope_key),
        state: tokenState({
          configured: h.configured,
          valid: h.valid,
          expiresAt: h.expires_at,
          dataAccessExpiresAt: h.data_access_expires_at,
        }),
        checked_at: h.checked_at,
        expires_at: h.expires_at,
        data_access_expires_at: h.data_access_expires_at,
        error: h.error,
      })),
      errors: {
        last_24h: last24,
        last_7d: (errs.data ?? []).length,
        groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 50),
      },
    }
  },
)

/** Re-check every Meta token now (same check and alerting as the cron). */
export const checkTokensNowFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ checked: number }> => {
    await requirePlatformAdmin()
    const results = await runMetaTokenChecks()
    return { checked: results.length }
  },
)
