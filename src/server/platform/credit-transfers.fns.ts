import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyTelegram } from '@/server/telegram/telegram.service'
import { notifyAdmins } from '@/server/notifications/notification.service'
import { formatUsd } from '@/lib/money/money'
import { UserError } from '@/lib/errors/user-error'
import {
  CREDIT_TRANSFER_SELECT,
  assertTransferable,
  liveTransferPreview,
  notifyTransferCompleted,
  pushTransferToMeta,
  transferRpcError,
} from '@/server/credit-transfers/credit-transfer.service'
import type { TransferPreview } from '@/server/credit-transfers/credit-transfer.service'
import type { CreditTransferRow } from '@/types/domain'

/**
 * Platform review of credit transfers that involve a pool account (migration
 * 000058). requirePlatformAdmin()-gated; the RPC also refuses to execute a
 * pool transfer for anyone who isn't a platform admin.
 */

async function loadTransfer(id: string): Promise<CreditTransferRow> {
  const admin = getSupabaseAdminClient()
  const { data, error } = await admin
    .from('credit_transfers')
    .select(CREDIT_TRANSFER_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new UserError('Credit transfer not found')
  return data as unknown as CreditTransferRow
}

/** Awaiting review first, then the most recent decided ones. */
export const listPlatformCreditTransfersFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<CreditTransferRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('credit_transfers')
      .select(CREDIT_TRANSFER_SELECT)
      .order('requested_at', { ascending: false })
      .limit(200)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as unknown as Array<CreditTransferRow>
    return [
      ...rows.filter((r) => r.status === 'PENDING_PLATFORM_REVIEW'),
      ...rows.filter((r) => r.status !== 'PENDING_PLATFORM_REVIEW'),
    ]
  },
)

/** Fresh Meta figures for a transfer under review. */
export const previewPlatformCreditTransferFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<TransferPreview> => {
    await requirePlatformAdmin()
    const t = await loadTransfer(data.id)
    return liveTransferPreview(getSupabaseAdminClient(), t.source_account_id, t.destination_account_id)
  })

export const approvePlatformCreditTransferFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ meta: { source: string; destination: string } }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const t = await loadTransfer(data.id)
    if (t.status !== 'PENDING_PLATFORM_REVIEW') {
      throw new UserError('This transfer is no longer awaiting review')
    }

    // Re-read Meta immediately before executing (design §3).
    const preview = await liveTransferPreview(admin, t.source_account_id, t.destination_account_id)
    assertTransferable(preview, Number(t.amount_usd))

    const { error } = await admin.rpc('apply_credit_transfer', {
      p_transfer_id: t.id,
      p_actor: actor.id,
    })
    if (error) throw new UserError(transferRpcError(error.message))

    const meta = await pushTransferToMeta(t.source_account_id, t.destination_account_id, actor.id)
    await notifyTransferCompleted({
      id: t.id,
      transfer_number: t.transfer_number,
      client_id: t.client_id,
      organization_id: t.organization_id,
      amount_usd: t.amount_usd,
      source_code: t.source?.account_code ?? '',
      destination_code: t.destination?.account_code ?? '',
      byPlatform: true,
    })
    await notifyAdmins({
      type: 'CREDIT_TRANSFER_APPROVED',
      title: `Credit transfer ${t.transfer_number} approved`,
      message: `${formatUsd(String(t.amount_usd))} moved from ${t.source?.account_code} to ${t.destination?.account_code}.`,
      entityType: 'CREDIT_TRANSFER',
      entityId: t.id,
      organizationId: t.organization_id,
    })
    return { meta }
  })

export const rejectPlatformCreditTransferFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), reason: z.string().trim().min(3, 'Give a reason').max(500) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const t = await loadTransfer(data.id)

    const { data: updated, error } = await admin
      .from('credit_transfers')
      .update({
        status: 'REJECTED',
        rejected_by: actor.id,
        rejected_at: new Date().toISOString(),
        rejection_reason: data.reason,
      })
      .eq('id', data.id)
      .eq('status', 'PENDING_PLATFORM_REVIEW')
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new UserError('This transfer is no longer awaiting review')
    }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: t.organization_id,
      action: 'CREDIT_TRANSFER_REJECTED',
      entityType: 'CREDIT_TRANSFER',
      entityId: t.id,
      newValues: { rejection_reason: data.reason },
    })
    await notifyAdmins({
      type: 'CREDIT_TRANSFER_REJECTED',
      title: `Credit transfer ${t.transfer_number} rejected`,
      message: data.reason,
      entityType: 'CREDIT_TRANSFER',
      entityId: t.id,
      organizationId: t.organization_id,
    })
    await notifyTelegram({
      eventType: 'credit_transfer.rejected',
      recipient: { type: 'agency', organizationId: t.organization_id },
      text: `❌ The platform rejected ${t.transfer_number} (${formatUsd(String(t.amount_usd))} from ${t.source?.account_code} to ${t.destination?.account_code}): ${data.reason}`,
      payload: { credit_transfer_id: t.id, transfer_number: t.transfer_number },
    })
    return { ok: true }
  })
