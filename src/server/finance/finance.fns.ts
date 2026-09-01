import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { usdMarginEntryCreateSchema } from '@/schemas/finance'
import type { UsdMarginEntry } from '@/types/domain'

export const listUsdMarginEntriesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<UsdMarginEntry>> => {
    await requireAdmin(PERMISSIONS.FINANCE_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: rows, error } = await admin
      .from('usd_margin_entries')
      .select('*')
      .order('transaction_date', { ascending: false })
      .limit(500)
    if (error) throw new Error(error.message)
    return rows as Array<UsdMarginEntry>
  },
)

export const createUsdMarginEntryFn = createServerFn({ method: 'POST' })
  .validator(usdMarginEntryCreateSchema)
  .handler(async ({ data }): Promise<UsdMarginEntry> => {
    const actor = await requireAdmin(PERMISSIONS.FINANCE_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: row, error } = await admin
      .from('usd_margin_entries')
      .insert({
        transaction_date: data.transaction_date,
        usd_amount: data.usd_amount,
        buying_rate: data.buying_rate,
        selling_rate: data.selling_rate,
      })
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'USD_MARGIN_ENTRY_RECORDED',
      entityType: 'USD_MARGIN_ENTRY',
      entityId: row.id,
      newValues: row,
    })
    return row as UsdMarginEntry
  })
