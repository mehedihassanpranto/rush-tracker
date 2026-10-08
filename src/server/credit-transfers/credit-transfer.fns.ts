import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { loadAccessibleAdAccount } from '@/server/ad-accounts/scope.server'
import { notifyPlatformAdmins } from '@/server/notifications/notification.service'
import { notifyTelegram } from '@/server/telegram/telegram.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
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
 * Agency side of credit transfers (migration 000058): move unused limit
 * between two ad accounts of the same client. Both accounts agency-owned →
 * executed at once; either one a platform pool account → sent to the
 * platform for review (platform/credit-transfers.fns.ts executes it).
 */

const pairSchema = z.object({ source_id: z.uuid(), destination_id: z.uuid() })

export interface TransferTarget {
  id: string
  account_code: string
  name: string
  current_limit_usd: string
  is_platform: boolean
}

/** Accounts the source's credit can move to: the other accounts actively
 * assigned to the same client, within this agency's scope. Server-side, so
 * the picker never filters an unscoped list (design §10). */
export const listTransferTargetsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ source_id: z.uuid() }))
  .handler(
    async ({ data }): Promise<{ client: { id: string; name: string } | null; source_is_platform: boolean; targets: Array<TransferTarget> }> => {
      const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
      const admin = getSupabaseAdminClient()
      const source = await loadAccessibleAdAccount(admin, data.source_id, actor.organizationId)

      const { data: assignment } = await admin
        .from('ad_account_assignments')
        .select('client_id, client:clients(id, name, organization_id)')
        .eq('ad_account_id', data.source_id)
        .eq('status', 'ACTIVE')
        .maybeSingle()
      const a = assignment as unknown as {
        client_id: string
        client: { id: string; name: string; organization_id: string } | null
      } | null
      if (!a || a.client?.organization_id !== actor.organizationId) {
        return { client: null, source_is_platform: source.is_platform, targets: [] }
      }

      const { data: siblings, error } = await admin
        .from('ad_account_assignments')
        .select('account:ad_accounts(id, account_code, name, current_limit_usd, is_platform, organization_id, status)')
        .eq('client_id', a.client_id)
        .eq('status', 'ACTIVE')
        .neq('ad_account_id', data.source_id)
      if (error) throw new Error(error.message)

      const targets: Array<TransferTarget> = []
      for (const row of (siblings ?? []) as unknown as Array<{
        account: (TransferTarget & { organization_id: string | null; status: string }) | null
      }>) {
        const acc = row.account
        if (!acc || acc.status !== 'ACTIVE') continue
        // Re-check scope per account (owned or granted to this agency).
        try {
          await loadAccessibleAdAccount(admin, acc.id, actor.organizationId)
        } catch {
          continue
        }
        targets.push({
          id: acc.id,
          account_code: acc.account_code,
          name: acc.name,
          current_limit_usd: String(acc.current_limit_usd),
          is_platform: acc.is_platform,
        })
      }
      return {
        client: a.client ? { id: a.client.id, name: a.client.name } : null,
        source_is_platform: source.is_platform,
        targets,
      }
    },
  )

/** Fresh Meta figures for both accounts (design §3, preview step). */
export const previewCreditTransferFn = createServerFn({ method: 'POST' })
  .validator(pairSchema)
  .handler(async ({ data }): Promise<TransferPreview> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()
    await loadAccessibleAdAccount(admin, data.source_id, actor.organizationId)
    await loadAccessibleAdAccount(admin, data.destination_id, actor.organizationId)
    return liveTransferPreview(admin, data.source_id, data.destination_id)
  })

const createSchema = pairSchema.extend({
  amount_usd: z.coerce.number().positive('Enter an amount greater than zero').max(10_000_000),
  note: z.string().trim().max(500).optional(),
})

export const createCreditTransferFn = createServerFn({ method: 'POST' })
  .validator(createSchema)
  .handler(
    async ({ data }): Promise<{ id: string; transfer_number: string; status: 'COMPLETED' | 'PENDING_PLATFORM_REVIEW'; meta: { source: string; destination: string } | null }> => {
      const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
      const admin = getSupabaseAdminClient()
      // Re-validated at submission (design §10) — and again inside the RPC.
      const source = await loadAccessibleAdAccount(admin, data.source_id, actor.organizationId)
      const destination = await loadAccessibleAdAccount(admin, data.destination_id, actor.organizationId)
      const involvesPool = source.is_platform || destination.is_platform

      // Fresh Meta read right before writing (design §3, execution step).
      // For a request the platform will execute, this still refuses an
      // amount that can't move today; the platform re-checks on approval.
      const preview = await liveTransferPreview(admin, data.source_id, data.destination_id)
      assertTransferable(preview, data.amount_usd)

      const { data: result, error } = await admin.rpc('create_credit_transfer', {
        p_organization_id: actor.organizationId,
        p_source: data.source_id,
        p_destination: data.destination_id,
        p_amount: data.amount_usd,
        p_note: data.note ?? null,
        p_actor: actor.id,
        p_execute: !involvesPool,
      })
      if (error) throw new UserError(transferRpcError(error.message))
      const r = result as { id: string; transfer_number: string; status: 'COMPLETED' | 'PENDING_PLATFORM_REVIEW' }

      const { data: row } = await admin
        .from('credit_transfers')
        .select(CREDIT_TRANSFER_SELECT)
        .eq('id', r.id)
        .single()
      const t = row as unknown as CreditTransferRow

      if (r.status === 'COMPLETED') {
        const meta = await pushTransferToMeta(data.source_id, data.destination_id, actor.id)
        await notifyTransferCompleted({
          id: t.id,
          transfer_number: t.transfer_number,
          client_id: t.client_id,
          organization_id: t.organization_id,
          amount_usd: t.amount_usd,
          source_code: t.source?.account_code ?? '',
          destination_code: t.destination?.account_code ?? '',
          byPlatform: false,
        })
        return { ...r, meta }
      }

      const agency = t.organization?.name ?? 'An agency'
      const text = `${agency} asks to move ${formatUsd(String(t.amount_usd))} from ${t.source?.account_code} to ${t.destination?.account_code} for ${t.client?.name ?? 'a client'} (${t.transfer_number}).`
      await notifyPlatformAdmins({
        type: 'CREDIT_TRANSFER_SENT_TO_PLATFORM',
        title: 'Credit transfer awaiting platform approval',
        message: text,
        entityType: 'CREDIT_TRANSFER',
        entityId: t.id,
      })
      await notifyTelegram({
        eventType: 'credit_transfer.sent_to_platform',
        recipient: { type: 'platform_admin' },
        text: `📨 ${text}`,
        payload: { credit_transfer_id: t.id, transfer_number: t.transfer_number },
      })
      return { ...r, meta: null }
    },
  )

/** Every transfer touching one ad account, newest first. */
export const listAccountCreditTransfersFn = createServerFn({ method: 'GET' })
  .validator(z.object({ ad_account_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<CreditTransferRow>> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_VIEW)
    const admin = getSupabaseAdminClient()
    await loadAccessibleAdAccount(admin, data.ad_account_id, actor.organizationId)
    const { data: rows, error } = await admin
      .from('credit_transfers')
      .select(CREDIT_TRANSFER_SELECT)
      .eq('organization_id', actor.organizationId)
      .or(`source_account_id.eq.${data.ad_account_id},destination_account_id.eq.${data.ad_account_id}`)
      .order('requested_at', { ascending: false })
    if (error) throw new Error(error.message)
    return (rows ?? []) as unknown as Array<CreditTransferRow>
  })
