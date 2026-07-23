import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { adjustmentCreateSchema, reverseSchema } from '@/schemas/adjustment'
import type { AdjustmentWithClient } from '@/types/domain'

function friendlyRpcError(message: string): string {
  return message.replace(/^.*?:\s*/, '').trim() || message
}

export const listAdjustmentsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid().optional() }))
  .handler(async ({ data }): Promise<Array<AdjustmentWithClient>> => {
    await requireAdmin(PERMISSIONS.ADJUSTMENTS_VIEW)
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('adjustments')
      .select(
        'id, adjustment_number, client_id, type, amount_bdt, reference_type, reference_id, reason, internal_note, created_at, client:clients(id, client_code, name)',
      )
      .order('created_at', { ascending: false })
      .limit(200)
    if (data.client_id) query = query.eq('client_id', data.client_id)

    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return rows as unknown as Array<AdjustmentWithClient>
  })

export const createAdjustmentFn = createServerFn({ method: 'POST' })
  .validator(adjustmentCreateSchema)
  .handler(async ({ data }): Promise<{ adjustment_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.ADJUSTMENTS_CREATE)
    const admin = getSupabaseAdminClient()
    const { data: id, error } = await admin.rpc('create_adjustment', {
      p_client_id: data.client_id,
      p_type: data.type,
      p_amount: data.amount_bdt,
      p_reason: data.reason,
      p_internal_note: data.internal_note ?? null,
      p_actor: actor.id,
    })
    if (error) throw new Error(friendlyRpcError(error.message))
    return { adjustment_id: id as string }
  })

export const reverseLedgerEntryFn = createServerFn({ method: 'POST' })
  .validator(reverseSchema)
  .handler(async ({ data }): Promise<{ reversal_ledger_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.ADJUSTMENTS_CREATE)
    const admin = getSupabaseAdminClient()
    const { data: id, error } = await admin.rpc('reverse_financial_transaction', {
      p_ledger_id: data.ledger_id,
      p_reason: data.reason,
      p_actor: actor.id,
    })
    if (error) throw new Error(friendlyRpcError(error.message))
    return { reversal_ledger_id: id as string }
  })
