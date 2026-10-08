import type { SupabaseClient } from '@supabase/supabase-js'
import { dec, formatUsd } from '@/lib/money/money'
import { metaCredentialScopeFor } from '@/lib/meta/credential-scope'
import { fetchMetaAdAccount } from '@/server/meta/meta.server'
import { syncAndPersistAdAccountSpendCap } from '@/server/meta/spend-cap-sync.server'
import { notifyClientMembers } from '@/server/notifications/notification.service'
import { notifyTelegram } from '@/server/telegram/telegram.service'
import { UserError } from '@/lib/errors/user-error'

/**
 * Credit transfers (migration 000058): move unused limit between two ad
 * accounts of the same client. Shared by the agency fns
 * (credit-transfer.fns.ts) and the platform fns (platform/credit-transfers.fns.ts).
 */

/** Columns + joins every credit-transfer list reads (CreditTransferRow). */
export const CREDIT_TRANSFER_SELECT =
  '*, client:clients(id, client_code, name), source:ad_accounts!credit_transfers_source_account_id_fkey(id, account_code, name, is_platform), destination:ad_accounts!credit_transfers_destination_account_id_fkey(id, account_code, name, is_platform), organization:organizations(id, name)'

/** "CODE: message" from the RPCs → the message. */
export function transferRpcError(message: string): string {
  return message.replace(/^[A-Z_]+:\s*/, '').trim() || message
}

export interface LiveSide {
  id: string
  account_code: string
  name: string
  current_limit_usd: string
  currency: string | null
  spend_cap: string | null
  amount_spent: string | null
}

export interface TransferPreview {
  source: LiveSide
  destination: LiveSide
  /** What can move now: min(our limit, Meta spend cap) − amount spent on Meta. */
  transferableUsd: string
}

interface AccountRow {
  id: string
  account_code: string
  name: string
  current_limit_usd: string | number
  external_account_id: string | null
  is_platform: boolean
  organization_id: string | null
  meta_sync_pending: boolean
}

const ACCOUNT_COLUMNS =
  'id, account_code, name, current_limit_usd, external_account_id, is_platform, organization_id, meta_sync_pending'

/**
 * Fresh Meta figures for both accounts and the amount that can move right now.
 * Called when the dialog previews and again immediately before executing —
 * never trusts a cached value (design §3). The CALLER authorizes the ids.
 */
export async function liveTransferPreview(
  admin: SupabaseClient,
  sourceId: string,
  destinationId: string,
): Promise<TransferPreview> {
  const { data, error } = await admin
    .from('ad_accounts')
    .select(ACCOUNT_COLUMNS)
    .in('id', [sourceId, destinationId])
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<AccountRow>
  const src = rows.find((r) => r.id === sourceId)
  const dst = rows.find((r) => r.id === destinationId)
  if (!src || !dst) throw new UserError('Ad account not found')

  for (const r of [src, dst]) {
    if (!r.external_account_id) {
      throw new UserError(`${r.account_code} isn't linked to a Meta ad account`)
    }
    if (r.meta_sync_pending) {
      throw new UserError(
        `${r.account_code}'s spend cap is out of sync with Meta — resolve that first`,
      )
    }
  }

  const [srcMeta, dstMeta] = await Promise.all(
    [src, dst].map((r) => fetchMetaAdAccount(r.external_account_id!, metaCredentialScopeFor(r))),
  )
  for (const [r, m] of [[src, srcMeta], [dst, dstMeta]] as const) {
    if (m.currency !== 'USD') {
      throw new UserError(
        `${r.account_code} is a ${m.currency ?? 'non'}-USD account on Meta — transfers are USD only`,
      )
    }
  }

  const limit = dec(String(src.current_limit_usd))
  const cap = srcMeta.spend_cap != null ? dec(srcMeta.spend_cap) : limit
  const ceiling = cap.lt(limit) ? cap : limit
  const transferable = ceiling.minus(dec(srcMeta.amount_spent ?? 0))

  const side = (r: AccountRow, m: typeof srcMeta): LiveSide => ({
    id: r.id,
    account_code: r.account_code,
    name: r.name,
    current_limit_usd: String(r.current_limit_usd),
    currency: m.currency,
    spend_cap: m.spend_cap,
    amount_spent: m.amount_spent,
  })
  return {
    source: side(src, srcMeta),
    destination: side(dst, dstMeta),
    transferableUsd: transferable.gt(0) ? transferable.toFixed(2) : '0.00',
  }
}

/** Throws unless `amount` fits what can move right now (design §3: fail
 * cleanly, never apply a partial amount). */
export function assertTransferable(preview: TransferPreview, amount: number): void {
  if (dec(amount).gt(dec(preview.transferableUsd))) {
    throw new UserError(
      `Only ${formatUsd(preview.transferableUsd)} can move from ${preview.source.account_code} right now (spend on Meta changed since you opened this). Re-enter the amount.`,
    )
  }
}

/**
 * Push both new limits to Meta. Source first: its spend cap goes DOWN, so a
 * failure can only leave the client with less headroom, never more. The
 * destination push is deferred automatically while the source is still out
 * of sync (guard in syncAndPersistAdAccountSpendCap), and goes out as soon as
 * the source succeeds — including from the daily retry.
 */
export async function pushTransferToMeta(
  sourceId: string,
  destinationId: string,
  actorUserId: string,
): Promise<{ source: string; destination: string }> {
  const source = await syncAndPersistAdAccountSpendCap(sourceId, {
    actorUserId,
    source: 'CREDIT_TRANSFER',
  })
  const destination = await syncAndPersistAdAccountSpendCap(destinationId, {
    actorUserId,
    source: 'CREDIT_TRANSFER',
  })
  return { source, destination }
}

/** Tell the client (in-app + Telegram) and, when the platform executed it,
 * the agency. */
export async function notifyTransferCompleted(t: {
  id: string
  transfer_number: string
  client_id: string
  organization_id: string
  amount_usd: string | number
  source_code: string
  destination_code: string
  byPlatform: boolean
}): Promise<void> {
  const text = `${formatUsd(String(t.amount_usd))} moved from ${t.source_code} to ${t.destination_code} (${t.transfer_number})`
  await notifyClientMembers(t.client_id, {
    type: 'CREDIT_TRANSFER_COMPLETED',
    title: 'Ad credit moved between your accounts',
    message: text,
    entityType: 'CREDIT_TRANSFER',
    entityId: t.id,
  })
  const payload = { credit_transfer_id: t.id, transfer_number: t.transfer_number }
  await notifyTelegram({
    eventType: 'credit_transfer.completed',
    recipient: { type: 'client', clientId: t.client_id },
    text: `🔁 ${text}.`,
    payload,
  })
  if (t.byPlatform) {
    await notifyTelegram({
      eventType: 'credit_transfer.completed',
      recipient: { type: 'agency', organizationId: t.organization_id },
      text: `✅ The platform approved ${t.transfer_number}: ${text}.`,
      payload,
    })
  }
}

/** Per assignment: completed credit moved out minus moved in (USD). */
export async function transferNetOutByAssignment(
  admin: SupabaseClient,
  assignmentIds: Array<string>,
): Promise<Map<string, string>> {
  const net = new Map<string, string>()
  if (assignmentIds.length === 0) return net
  const ids = assignmentIds.join(',')
  const { data, error } = await admin
    .from('credit_transfers')
    .select('source_assignment_id, destination_assignment_id, amount_usd')
    .eq('status', 'COMPLETED')
    .or(`source_assignment_id.in.(${ids}),destination_assignment_id.in.(${ids})`)
  if (error) throw new Error(error.message)
  const add = (id: string, v: ReturnType<typeof dec>) =>
    net.set(id, dec(net.get(id) ?? 0).plus(v).toFixed(2))
  for (const t of (data ?? []) as Array<{
    source_assignment_id: string
    destination_assignment_id: string
    amount_usd: string | number
  }>) {
    const amount = dec(String(t.amount_usd))
    if (assignmentIds.includes(t.source_assignment_id)) add(t.source_assignment_id, amount)
    if (assignmentIds.includes(t.destination_assignment_id)) add(t.destination_assignment_id, amount.neg())
  }
  return net
}
