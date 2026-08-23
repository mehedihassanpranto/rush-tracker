import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import {
  requireAdmin,
  requireClientMembership,
} from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import {
  notifyAdmins,
  notifyClientMembers,
} from '@/server/notifications/notification.service'
import { syncAndPersistAdAccountSpendCap } from '@/server/meta/spend-cap-sync.server'
import { sendTelegramMessage } from '@/server/telegram/telegram.service'
import { uploadProof, signProofUrl } from '@/server/storage/storage.service'
import { adAccountUsdRate } from '@/server/exchange-rates/rate.service'
import { addUsd, dec, formatBdt, formatUsd, multiplyUsdByRate } from '@/lib/money/money'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  limitApproveSchema,
  limitRejectSchema,
  limitRequestCreateSchema,
  limitRequestIdSchema,
  limitRequestListSchema,
  proofUploadSchema,
} from '@/schemas/limit-request'
import type {
  AdAccountStatus,
  LimitRequest,
  LimitRequestDetail,
  LimitRequestWithRefs,
} from '@/types/domain'

const PROOF_ENTITY = 'LIMIT_APPROVAL_PROOF'

function friendlyRpcError(message: string): string {
  return message.replace(/^.*?:\s*/, '').trim() || message
}

// ===========================================================================
// Client
// ===========================================================================

export interface RequestableAccount {
  id: string
  account_code: string
  name: string
  status: AdAccountStatus
  current_limit_usd: string
  has_pending: boolean
  /** Resolved rate this request would bill at (account's own rate, falling
   * back to the client's) — shown to the client as a read-only preview of
   * what they'll owe, same resolution `createLimitRequestFn` uses. */
  usd_rate: string
}

export interface RequestableAccountsResult {
  /** The signed-in client's segment — determines whether the request dialog
   * shows the amount-paid/proof fields at all (prepaid) or not (postpaid). */
  segment: 'prepaid' | 'postpaid'
  accounts: Array<RequestableAccount>
}

/** Active accounts the signed-in client can request a limit for (spec §21, §67). */
export const listMyRequestableAccountsFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<RequestableAccountsResult> => {
  const { membership } = await requireClientMembership()
  const admin = getSupabaseAdminClient()

  const [{ data: rows, error }, { data: clientRow }] = await Promise.all([
    admin
      .from('ad_account_assignments')
      .select('account:ad_accounts(id, account_code, name, status, current_limit_usd)')
      .eq('client_id', membership.clientId)
      .eq('status', 'ACTIVE'),
    admin.from('clients').select('segment').eq('id', membership.clientId).single(),
  ])
  if (error) throw new Error(error.message)
  const segment = (clientRow as { segment: 'prepaid' | 'postpaid' } | null)?.segment ?? 'postpaid'

  const accounts = (rows ?? [])
    .map(
      (r) =>
        (r as unknown as { account: Omit<RequestableAccount, 'has_pending' | 'usd_rate'> | null })
          .account,
    )
    .filter((a): a is Omit<RequestableAccount, 'has_pending' | 'usd_rate'> => a !== null)

  if (accounts.length === 0) return { segment, accounts: [] }

  const [{ data: pending }, rates] = await Promise.all([
    admin
      .from('limit_requests')
      .select('ad_account_id')
      .eq('client_id', membership.clientId)
      .eq('status', 'PENDING'),
    Promise.all(
      accounts.map((a) => adAccountUsdRate(a.id, membership.clientId)),
    ),
  ])
  const pendingIds = new Set(
    (pending ?? []).map((p) => (p as { ad_account_id: string }).ad_account_id),
  )

  return {
    segment,
    accounts: accounts.map((a, i) => ({
      ...a,
      has_pending: pendingIds.has(a.id),
      usd_rate: rates[i],
    })),
  }
})

export const createLimitRequestFn = createServerFn({ method: 'POST' })
  .validator(limitRequestCreateSchema)
  .handler(async ({ data }): Promise<LimitRequest> => {
    const { user, membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    // Verify the account is actively assigned to THIS client.
    const { data: assignment } = await admin
      .from('ad_account_assignments')
      .select('id')
      .eq('ad_account_id', data.ad_account_id)
      .eq('client_id', membership.clientId)
      .eq('status', 'ACTIVE')
      .maybeSingle()
    if (!assignment) {
      throw new Error('This account is not assigned to your organization')
    }

    const { data: account } = await admin
      .from('ad_accounts')
      .select('account_code, name, status, current_limit_usd')
      .eq('id', data.ad_account_id)
      .single()
    if (!account) throw new Error('Account not found')
    if ((account as { status: AdAccountStatus }).status !== 'ACTIVE') {
      throw new Error('This account is not active and cannot receive requests')
    }

    const acc = account as {
      account_code: string
      name: string
      current_limit_usd: string
    }
    const opening = acc.current_limit_usd
    const rate = await adAccountUsdRate(data.ad_account_id, membership.clientId)
    const expected = addUsd(opening, data.requested_amount_usd).toString()
    const totalCost = multiplyUsdByRate(data.requested_amount_usd, rate).toString()

    // Segment is looked up server-side — never trusted from the client
    // payload, so a postpaid client can't submit prepaid-looking fields to
    // bypass anything.
    const { data: clientRow } = await admin
      .from('clients')
      .select('name, segment')
      .eq('id', membership.clientId)
      .single()
    if (!clientRow) throw new Error('Client not found')
    const { name: clientName, segment } = clientRow as {
      name: string
      segment: 'prepaid' | 'postpaid'
    }

    let amountPaid = '0'
    let dueBalance = totalCost
    let hasProof = false

    if (segment === 'prepaid') {
      if (data.amount_paid_bdt == null || data.amount_paid_bdt <= 0) {
        throw new Error('Enter how much you paid')
      }
      if (dec(data.amount_paid_bdt).gt(totalCost)) {
        throw new Error(`Amount paid cannot exceed the total cost of ${formatBdt(totalCost)}`)
      }
      if (!data.file_name || !data.mime_type || !data.data_base64) {
        throw new Error('Attach payment proof')
      }
      amountPaid = dec(data.amount_paid_bdt).toFixed(2)
      dueBalance = dec(totalCost).minus(amountPaid).toFixed(2)
      hasProof = true
    }
    // postpaid: amountPaid stays '0', dueBalance stays the full totalCost,
    // and any amount_paid_bdt/proof fields the payload might still carry
    // are simply never read below — ignored, not validated.

    const { data: created, error } = await admin
      .from('limit_requests')
      .insert({
        client_id: membership.clientId,
        ad_account_id: data.ad_account_id,
        assignment_id: (assignment as { id: string }).id,
        opening_balance_usd: opening,
        requested_amount_usd: data.requested_amount_usd,
        default_usd_rate: rate,
        expected_new_limit_usd: expected,
        requested_by: user.id,
        status: 'PENDING',
        segment,
        total_cost_bdt: totalCost,
        amount_paid_bdt: amountPaid,
        due_balance_bdt: dueBalance,
      })
      .select('*')
      .single()

    if (error) {
      // 23505 = unique violation on the one-pending-per-account index.
      if (error.code === '23505') {
        throw new Error('A pending request already exists for this account')
      }
      throw new Error(error.message)
    }

    // Prepaid only: attach the client's payment proof; roll back the
    // request if storage/attachment fails so a prepaid request can never
    // exist without proof (same pattern as submitPaymentFn).
    if (hasProof) {
      try {
        const stored = await uploadProof({
          folder: `limit-requests/${created.id}`,
          mimeType: data.mime_type!,
          dataBase64: data.data_base64!,
        })
        const { error: attErr } = await admin.from('attachments').insert({
          entity_type: PROOF_ENTITY,
          entity_id: created.id,
          storage_bucket: 'proofs',
          storage_path: stored.storage_path,
          original_file_name: data.file_name,
          mime_type: data.mime_type,
          file_size: stored.file_size,
          uploaded_by: user.id,
        })
        if (attErr) throw new Error(attErr.message)
      } catch (err) {
        await admin.from('limit_requests').delete().eq('id', created.id)
        throw err instanceof Error ? err : new Error('Failed to attach proof')
      }
    }

    await writeAudit({
      actorUserId: user.id,
      action: 'LIMIT_REQUEST_CREATED',
      entityType: 'LIMIT_REQUEST',
      entityId: created.id,
      newValues: {
        ad_account_id: data.ad_account_id,
        requested_amount_usd: data.requested_amount_usd,
        opening_balance_usd: opening,
      },
    })

    await notifyAdmins({
      type: 'LIMIT_REQUEST_CREATED',
      title: 'New limit request',
      message: `${created.request_number}: ${formatUsd(
        data.requested_amount_usd,
      )} requested`,
      entityType: 'LIMIT_REQUEST',
      entityId: created.id,
    })

    await sendTelegramMessage(
      `🔔 New limit request ${created.request_number}: ${clientName} requested ${formatUsd(data.requested_amount_usd)} on ${acc.account_code} "${acc.name}".`,
    )

    return created as LimitRequest
  })

export const listMyLimitRequestsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<LimitRequestWithRefs>> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('limit_requests')
      .select(
        '*, ad_account:ad_accounts(id, account_code, name)',
      )
      .eq('client_id', membership.clientId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => ({
      ...(r as unknown as LimitRequestWithRefs),
      client: null,
    }))
  },
)

export const cancelMyLimitRequestFn = createServerFn({ method: 'POST' })
  .validator(limitRequestIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { user, membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    const { data: updated, error } = await admin
      .from('limit_requests')
      .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
      .eq('id', data.id)
      .eq('client_id', membership.clientId)
      .eq('status', 'PENDING')
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new Error('Request can no longer be cancelled')
    }

    await writeAudit({
      actorUserId: user.id,
      action: 'LIMIT_REQUEST_CANCELLED',
      entityType: 'LIMIT_REQUEST',
      entityId: data.id,
    })
    return { ok: true }
  })

/** Signed URL for the proof of the client's own approved request (spec §52). */
export const getMyProofUrlFn = createServerFn({ method: 'POST' })
  .validator(limitRequestIdSchema)
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    const { data: req } = await admin
      .from('limit_requests')
      .select('id')
      .eq('id', data.id)
      .eq('client_id', membership.clientId)
      .maybeSingle()
    if (!req) throw new Error('Request not found')

    const path = await proofPathForRequest(data.id)
    if (!path) return { url: null }
    return { url: await signProofUrl(path) }
  })

// ===========================================================================
// Admin
// ===========================================================================

async function proofPathForRequest(requestId: string): Promise<string | null> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('attachments')
    .select('storage_path')
    .eq('entity_type', PROOF_ENTITY)
    .eq('entity_id', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { storage_path: string } | null)?.storage_path ?? null
}

export const listLimitRequestsFn = createServerFn({ method: 'GET' })
  .validator(limitRequestListSchema)
  .handler(async ({ data }): Promise<Array<LimitRequestWithRefs>> => {
    await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_VIEW)
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('limit_requests')
      .select(
        '*, client:clients(id, client_code, name), ad_account:ad_accounts(id, account_code, name)',
      )
      .order('created_at', { ascending: false })
    if (data.status !== 'ALL') query = query.eq('status', data.status)

    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return rows as unknown as Array<LimitRequestWithRefs>
  })

/**
 * Usage history for one ad account (spec §28's additive model, surfaced as
 * a running trail): every APPROVED limit request against this account,
 * chronological, across every client that has ever held it — each row is
 * already a complete opening-balance -> +approved -> new-limit record, so
 * no separate tracking table is needed.
 */
export const listAdAccountUsageFn = createServerFn({ method: 'GET' })
  .validator(z.object({ ad_account_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<LimitRequestWithRefs>> => {
    await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: rows, error } = await admin
      .from('limit_requests')
      .select(
        '*, client:clients(id, client_code, name), ad_account:ad_accounts(id, account_code, name)',
      )
      .eq('ad_account_id', data.ad_account_id)
      .eq('status', 'APPROVED')
      .order('approved_at', { ascending: true })
    if (error) throw new Error(error.message)
    return rows as unknown as Array<LimitRequestWithRefs>
  })

/**
 * A client's approved limit-request history (client detail page's Limit
 * Requests tab) — every APPROVED request across every ad account this
 * client has ever held, most recent approval first.
 */
export const listClientLimitRequestsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<LimitRequestWithRefs>> => {
    await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: rows, error } = await admin
      .from('limit_requests')
      .select(
        '*, client:clients(id, client_code, name), ad_account:ad_accounts(id, account_code, name)',
      )
      .eq('client_id', data.client_id)
      .eq('status', 'APPROVED')
      .order('approved_at', { ascending: false })
    if (error) throw new Error(error.message)
    return rows as unknown as Array<LimitRequestWithRefs>
  })

export const getLimitRequestDetailFn = createServerFn({ method: 'GET' })
  .validator(limitRequestIdSchema)
  .handler(async ({ data }): Promise<LimitRequestDetail> => {
    await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: req, error } = await admin
      .from('limit_requests')
      .select(
        '*, client:clients(id, client_code, name), ad_account:ad_accounts(id, account_code, name)',
      )
      .eq('id', data.id)
      .single()
    if (error) throw new Error(error.message)
    const request = req as unknown as LimitRequestWithRefs

    const { data: account } = await admin
      .from('ad_accounts')
      .select('current_limit_usd')
      .eq('id', request.ad_account_id)
      .single()
    const currentLimit =
      (account as { current_limit_usd: string } | null)?.current_limit_usd ?? null

    const applicableRate = await adAccountUsdRate(
      request.ad_account_id,
      request.client_id,
    )

    const path = await proofPathForRequest(data.id)
    const isStale =
      request.status === 'PENDING' &&
      currentLimit !== null &&
      Number(request.opening_balance_usd) !== Number(currentLimit)

    return {
      ...request,
      account_current_limit_usd: currentLimit,
      applicable_usd_rate: applicableRate,
      has_proof: path !== null,
      is_stale: isStale,
    }
  })

export const uploadLimitProofFn = createServerFn({ method: 'POST' })
  .validator(proofUploadSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_APPROVE)
    const admin = getSupabaseAdminClient()

    const { data: req } = await admin
      .from('limit_requests')
      .select('status')
      .eq('id', data.request_id)
      .single()
    if (!req) throw new Error('Request not found')
    if ((req as { status: string }).status !== 'PENDING') {
      throw new Error('Proof can only be attached to a pending request')
    }

    const stored = await uploadProof({
      folder: `limit-requests/${data.request_id}`,
      mimeType: data.mime_type,
      dataBase64: data.data_base64,
    })

    const { error } = await admin.from('attachments').insert({
      entity_type: PROOF_ENTITY,
      entity_id: data.request_id,
      storage_bucket: 'proofs',
      storage_path: stored.storage_path,
      original_file_name: data.file_name,
      mime_type: data.mime_type,
      file_size: stored.file_size,
      uploaded_by: actor.id,
    })
    if (error) throw new Error(error.message)
    return { ok: true }
  })

export const getLimitProofUrlFn = createServerFn({ method: 'POST' })
  .validator(limitRequestIdSchema)
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_VIEW)
    const path = await proofPathForRequest(data.id)
    if (!path) return { url: null }
    return { url: await signProofUrl(path) }
  })

export const approveLimitRequestFn = createServerFn({ method: 'POST' })
  .validator(limitApproveSchema)
  .handler(async ({ data }): Promise<{ ledger_id: string; payment_id: string | null }> => {
    const actor = await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_APPROVE)
    const admin = getSupabaseAdminClient()

    const { data: result, error } = await admin.rpc('approve_limit_request', {
      p_request_id: data.id,
      p_approved_amount: data.approved_amount_usd,
      p_approved_rate: data.approved_usd_rate,
      p_actor: actor.id,
      p_admin_note: data.admin_note ?? null,
    })
    if (error) throw new Error(friendlyRpcError(error.message))
    const { ledger_id: ledgerId, payment_id: paymentId } = result as {
      ledger_id: string
      payment_id: string | null
      payment_ledger_id: string | null
    }

    // Prepaid only (paymentId is null for postpaid — nothing to link).
    // Link the client's already-uploaded request proof to the auto-created
    // payment too, so it shows in Payment History with proof like any other
    // payment — best-effort, never blocks the (already-committed) approval.
    try {
      const path = paymentId ? await proofPathForRequest(data.id) : null
      if (paymentId && path) {
        const { data: att } = await admin
          .from('attachments')
          .select('original_file_name, mime_type, file_size')
          .eq('entity_type', PROOF_ENTITY)
          .eq('entity_id', data.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        await admin.from('attachments').insert({
          entity_type: 'PAYMENT_PROOF',
          entity_id: paymentId,
          storage_bucket: 'proofs',
          storage_path: path,
          original_file_name: (att as { original_file_name: string | null } | null)
            ?.original_file_name,
          mime_type: (att as { mime_type: string | null } | null)?.mime_type,
          file_size: (att as { file_size: number | null } | null)?.file_size,
          uploaded_by: actor.id,
        })
      }
    } catch (err) {
      console.error('[limit-request] failed to link proof to auto-payment', data.id, err)
    }

    const { data: req } = await admin
      .from('limit_requests')
      .select('client_id, request_number, ad_account_id')
      .eq('id', data.id)
      .maybeSingle()
    if (req) {
      const r = req as {
        client_id: string
        request_number: string
        ad_account_id: string
      }
      await notifyClientMembers(r.client_id, {
        type: 'LIMIT_REQUEST_APPROVED',
        title: 'Limit request approved',
        message: `${r.request_number}: approved for ${formatUsd(
          data.approved_amount_usd,
        )}`,
        entityType: 'LIMIT_REQUEST',
        entityId: data.id,
      })

      // Best-effort: push the new limit to the linked Meta ad account's
      // spend_cap. Never throws — a Meta-side failure must not roll back
      // this approval (already committed atomically above); it's flagged
      // via meta_sync_pending + a notification + retry instead (spec
      // decision: see the "Auto-push approved limit to Meta spend_cap" plan).
      await syncAndPersistAdAccountSpendCap(r.ad_account_id, {
        actorUserId: actor.id,
        source: 'META_SPEND_CAP_AUTO_SYNC',
      })
    }
    return { ledger_id: ledgerId, payment_id: paymentId }
  })

export const rejectLimitRequestFn = createServerFn({ method: 'POST' })
  .validator(limitRejectSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_APPROVE)
    const admin = getSupabaseAdminClient()

    const { data: updated, error } = await admin
      .from('limit_requests')
      .update({
        status: 'REJECTED',
        rejection_reason: data.rejection_reason,
        reviewed_by: actor.id,
        reviewed_at: new Date().toISOString(),
        rejected_at: new Date().toISOString(),
      })
      .eq('id', data.id)
      .eq('status', 'PENDING')
      .select('id, client_id, request_number')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new Error('Request is no longer pending')
    }

    await writeAudit({
      actorUserId: actor.id,
      action: 'LIMIT_REQUEST_REJECTED',
      entityType: 'LIMIT_REQUEST',
      entityId: data.id,
      newValues: { rejection_reason: data.rejection_reason },
    })

    const rejected = updated[0] as {
      client_id: string
      request_number: string
    }
    await notifyClientMembers(rejected.client_id, {
      type: 'LIMIT_REQUEST_REJECTED',
      title: 'Limit request rejected',
      message: `${rejected.request_number}: ${data.rejection_reason}`,
      entityType: 'LIMIT_REQUEST',
      entityId: data.id,
    })
    return { ok: true }
  })

export const rebaseLimitRequestFn = createServerFn({ method: 'POST' })
  .validator(limitRequestIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_APPROVE)
    const admin = getSupabaseAdminClient()
    const { error } = await admin.rpc('rebase_limit_request', {
      p_request_id: data.id,
      p_actor: actor.id,
    })
    if (error) throw new Error(friendlyRpcError(error.message))
    return { ok: true }
  })
