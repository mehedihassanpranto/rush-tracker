import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { setDefaultRateSchema } from '@/schemas/limit-request'
import type { ExchangeRate } from '@/types/domain'

/** Current default USD→BDT rate (latest exchange_rates row). */
export const getDefaultRateFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ rate: string }> => {
    await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('exchange_rates')
      .select('rate')
      .order('effective_from', { ascending: false })
      .limit(1)
      .single()
    if (error) throw new Error(error.message)
    return { rate: (data as { rate: string }).rate }
  },
)

export const listRateHistoryFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<ExchangeRate>> => {
    await requireAdmin(PERMISSIONS.EXCHANGE_RATE_MANAGE)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('exchange_rates')
      .select('id, rate, effective_from, created_at')
      .order('effective_from', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return data as Array<ExchangeRate>
  },
)

/** Change the default rate — sensitive (spec §26, §27). Adds a new history
 *  row; past approvals keep their immutable snapshot. */
export const setDefaultRateFn = createServerFn({ method: 'POST' })
  .validator(setDefaultRateSchema)
  .handler(async ({ data }): Promise<{ rate: number }> => {
    const actor = await requireAdmin(PERMISSIONS.EXCHANGE_RATE_MANAGE)
    const admin = getSupabaseAdminClient()

    const { error } = await admin
      .from('exchange_rates')
      .insert({ rate: data.rate, changed_by: actor.id })
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'DEFAULT_RATE_CHANGED',
      entityType: 'EXCHANGE_RATE',
      newValues: { rate: data.rate },
    })
    return { rate: data.rate }
  })
