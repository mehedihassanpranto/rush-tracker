import { createServerFn } from '@tanstack/react-start'
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
import { uploadProof, signProofUrl } from '@/server/storage/storage.service'
import { adAccountUsdRate } from '@/server/exchange-rates/rate.service'
import { addUsd, formatUsd } from '@/lib/money/money'
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
}

/** Active accounts the signed-in client can request a limit for (spec §21, §67). */
export const listMyRequestableAccountsFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Array<RequestableAccount>> => {
  const { membership } = await requireClientMembership()
  const admin = getSupabaseAdminClient()

  const { data: rows, error } = await admin
    .from('ad_account_assignments')
    .select('account:ad_accounts(id, account_code, name, status, current_limit_usd)')
    .eq('client_id', membership.clientId)
    .eq('status', 'ACTIVE')
  if (error) throw new Error(error.message)

  const accounts = (rows ?? [])
    .map(
      (r) =>
        (r as unknown as { account: RequestableAccount | null }).account,
    )
    .filter((a): a is RequestableAccount => a !== null)

  if (accounts.length === 0) return []

  const { data: pending } = await admin
    .from('limit_requests')
    .select('ad_account_id')
    .eq('client_id', membership.clientId)
    .eq('status', 'PENDING')
  const pendingIds = new Set(
    (pending ?? []).map((p) => (p as { ad_account_id: string }).ad_account_id),
  )

  return accounts.map((a) => ({ ...a, has_pending: pendingIds.has(a.id) }))
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
      .select('status, current_limit_usd')
      .eq('id', data.ad_account_id)
      .single()
    if (!account) throw new Error('Account not found')
    if ((account as { status: AdAccountStatus }).status !== 'ACTIVE') {
      throw new Error('This account is not active and cannot receive requests')
    }

    const opening = (account as { current_limit_usd: string }).current_limit_usd
    const rate = await adAccountUsdRate(data.ad_account_id, membership.clientId)
    const expected = addUsd(opening, data.requested_amount_usd).toString()

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
  .handler(async ({ data }): Promise<{ ledger_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.LIMIT_REQUESTS_APPROVE)
    const admin = getSupabaseAdminClient()

    // Proof is mandatory before approval (spec §29).
    const path = await proofPathForRequest(data.id)
    if (!path) {
      throw new Error('Upload the limit update proof before approving')
    }

    const { data: ledgerId, error } = await admin.rpc('approve_limit_request', {
      p_request_id: data.id,
      p_approved_amount: data.approved_amount_usd,
      p_approved_rate: data.approved_usd_rate,
      p_actor: actor.id,
      p_admin_note: data.admin_note ?? null,
    })
    if (error) throw new Error(friendlyRpcError(error.message))

    const { data: req } = await admin
      .from('limit_requests')
      .select('client_id, request_number')
      .eq('id', data.id)
      .maybeSingle()
    if (req) {
      const r = req as { client_id: string; request_number: string }
      await notifyClientMembers(r.client_id, {
        type: 'LIMIT_REQUEST_APPROVED',
        title: 'Limit request approved',
        message: `${r.request_number}: approved for ${formatUsd(
          data.approved_amount_usd,
        )}`,
        entityType: 'LIMIT_REQUEST',
        entityId: data.id,
      })
    }
    return { ledger_id: ledgerId as string }
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
