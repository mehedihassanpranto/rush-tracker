import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Writes to the monitoring tables (migration 000054). Every function here is
 * best-effort and NEVER throws: monitoring must not be the thing that breaks a
 * request or a cron run. A plain service module with the admin client passed
 * in, like the other shared server helpers (see pool-grant.service.ts).
 */

export async function startCronRun(
  admin: SupabaseClient,
  job: string,
  summary: Record<string, unknown> = {},
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from('cron_runs')
      .insert({ job, summary })
      .select('id')
      .single()
    if (error) throw error
    return data.id as string
  } catch (err) {
    console.error('[monitoring] could not record cron start', err)
    return null
  }
}

export async function finishCronRun(
  admin: SupabaseClient,
  id: string | null,
  status: 'success' | 'partial' | 'failed',
  summary: Record<string, unknown>,
  error: string | null = null,
): Promise<void> {
  if (!id) return
  try {
    const { error: e } = await admin
      .from('cron_runs')
      .update({ status, summary, error, finished_at: new Date().toISOString() })
      .eq('id', id)
    if (e) throw e
  } catch (err) {
    console.error('[monitoring] could not record cron finish', err)
  }
}

export interface AppErrorInput {
  source: 'server_fn' | 'cron'
  error: unknown
  fnName?: string | null
  fnFile?: string | null
  userId?: string | null
  organizationId?: string | null
}

export async function recordAppError(
  admin: SupabaseClient,
  input: AppErrorInput,
): Promise<void> {
  try {
    const e = input.error as { name?: unknown; message?: unknown; stack?: unknown }
    const message =
      typeof e?.message === 'string' && e.message
        ? e.message
        : typeof input.error === 'string'
          ? input.error
          : 'Unknown error'
    const { error } = await admin.from('app_errors').insert({
      source: input.source,
      name: typeof e?.name === 'string' ? e.name : null,
      message: message.slice(0, 2000),
      stack: typeof e?.stack === 'string' ? e.stack.slice(0, 8000) : null,
      fn_name: input.fnName ?? null,
      fn_file: input.fnFile ?? null,
      user_id: input.userId ?? null,
      organization_id: input.organizationId ?? null,
    })
    if (error) throw error
  } catch (err) {
    console.error('[monitoring] could not record app error', err)
  }
}

/** Keep the error log to the last 30 days, cron history to 90, and sign-in
 * attempts to 7 (rate limits only look back an hour). */
export async function pruneMonitoringTables(admin: SupabaseClient): Promise<void> {
  try {
    const day = 86_400_000
    await admin
      .from('app_errors')
      .delete()
      .lt('occurred_at', new Date(Date.now() - 30 * day).toISOString())
    await admin
      .from('cron_runs')
      .delete()
      .lt('started_at', new Date(Date.now() - 90 * day).toISOString())
    await admin
      .from('auth_attempts')
      .delete()
      .lt('attempted_at', new Date(Date.now() - 7 * day).toISOString())
  } catch (err) {
    console.error('[monitoring] prune failed', err)
  }
}
