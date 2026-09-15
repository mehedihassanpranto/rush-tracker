import { createServerFn } from '@tanstack/react-start'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyClientMembers } from '@/server/notifications/notification.service'
import { adAccountUsdRate } from '@/server/exchange-rates/rate.service'
import { signProofUrl } from '@/server/storage/storage.service'
import {
  finishLimitRequestApproval,
  proofPathForRequest,
} from '@/server/limit-requests/limit-request-approval.service'
import { friendlyRpcError } from '@/server/limit-requests/limit-request.fns'
import {
  limitApproveSchema,
  limitRejectSchema,
  limitRequestIdSchema,
  limitRequestListSchema,
} from '@/schemas/limit-request'
import type { LimitRequestDetail, LimitRequestWithRefs } from '@/types/domain'

/**
 * Limit requests on platform-assigned accounts (spec §4.3 of the "Mother
 * Platform Account Control" doc) — the agency reviews a client's request and
 * sends it here instead of approving directly (sendLimitRequestToPlatformFn,
 * limit-request.fns.ts), and approval here is what actually performs the cap
 * increase, via the exact same approve_limit_request RPC the agency's own
 * approval uses.
 *
 * Every fn here is requirePlatformAdmin()-gated and scoped by
 * ad_accounts.is_platform = true, not by organization — a request can belong
 * to any agency's client, since the platform reviews escalations across every
 * agency at once. p_organization_id passed to the RPCs is always resolved
 * from the REQUEST's own row (the client's agency), never from the platform
 * admin's own organization, which has no bearing on whose ledger this is.
 */

interface PlatformLimitRequestRow extends LimitRequestWithRefs {
  organization: { id: string; name: string } | null
}

const SELECT =
  '*, client:clients(id, client_code, name), ad_account:ad_accounts(id, account_code, name, is_platform), organization:organizations(id, name)'

/** Every limit request against a platform-assigned account, across every
 * agency — the platform counterpart of listLimitRequestsFn. Defaults to the
 * escalated queue; other statuses are visibility only; the agency's own
 * PENDING requests are included so the platform can see what's in flight
 * before it's sent up, even though only PENDING_PLATFORM_REVIEW is
 * actionable here. */
export const listPlatformLimitRequestsFn = createServerFn({ method: 'GET' })
  .validator(limitRequestListSchema)
  .handler(async ({ data }): Promise<Array<PlatformLimitRequestRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    let query = admin
      .from('limit_requests')
      .select(SELECT)
      .order('sent_to_platform_at', { ascending: true, nullsFirst: false })
      .order('requested_at', { ascending: true })
    if (data.status !== 'ALL') query = query.eq('status', data.status)

    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    // Filtered to platform-assigned accounts in JS rather than a PostgREST
    // filter on the joined table — this dataset is small (every limit
    // request across every agency, already narrowed by status), and it
    // avoids depending on embedded-resource filter syntax with no other
    // precedent in this codebase.
    return ((rows ?? []) as unknown as Array<PlatformLimitRequestRow>).filter(
      (r) => r.ad_account?.is_platform === true,
    )
  })

/** One request, with the enclosing agency's name — the platform's
 * counterpart of getLimitRequestDetailFn. Requires the account to actually be
 * platform-assigned, defense in depth beyond the list already being scoped
 * that way. */
export const getPlatformLimitRequestFn = createServerFn({ method: 'GET' })
  .validator(limitRequestIdSchema)
  .handler(async ({ data }): Promise<LimitRequestDetail & { organization: { id: string; name: string } | null }> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: req, error } = await admin
      .from('limit_requests')
      .select(SELECT)
      .eq('id', data.id)
      .single()
    if (error) throw new Error(error.message)
    const request = req as unknown as PlatformLimitRequestRow
    if (!request.ad_account?.is_platform) {
      throw new Error('Request not found')
    }

    const { data: account } = await admin
      .from('ad_accounts')
      .select('current_limit_usd')
      .eq('id', request.ad_account_id)
      .single()
    const currentLimit =
      (account as { current_limit_usd: string } | null)?.current_limit_usd ?? null

    const applicableRate = await adAccountUsdRate(request.ad_account_id, request.client_id)
    const path = await proofPathForRequest(data.id)
    const isStale =
      (request.status === 'PENDING' || request.status === 'PENDING_PLATFORM_REVIEW') &&
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

/** Signed URL for a request's payment proof (prepaid/partial clients only) —
 * the platform counterpart of getLimitProofUrlFn, so a platform reviewer can
 * verify payment before approving an escalated request exactly like an
 * agency reviewer already can. Scoped by is_platform, not organization. */
export const getPlatformLimitProofUrlFn = createServerFn({ method: 'POST' })
  .validator(limitRequestIdSchema)
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: req } = await admin
      .from('limit_requests')
      .select('id, ad_account:ad_accounts(is_platform)')
      .eq('id', data.id)
      .maybeSingle()
    const isPlatformAccount = (
      req as unknown as { ad_account: { is_platform: boolean } | null } | null
    )?.ad_account?.is_platform
    if (!req || !isPlatformAccount) throw new Error('Request not found')
    const path = await proofPathForRequest(data.id)
    if (!path) return { url: null }
    return { url: await signProofUrl(path) }
  })

async function loadPlatformRequestForAction(admin: SupabaseClient, id: string) {
  const { data: req } = await admin
    .from('limit_requests')
    .select('status, organization_id, ad_account:ad_accounts(is_platform)')
    .eq('id', id)
    .maybeSingle()
  const r = req as unknown as {
    status: string
    organization_id: string
    ad_account: { is_platform: boolean } | null
  } | null
  if (!r || !r.ad_account?.is_platform) {
    throw new Error('Request not found')
  }
  return r
}

/** Approves an escalated request — calls the SAME approve_limit_request RPC
 * the agency's own approval uses, with p_organization_id resolved from the
 * request's own client/agency (the platform admin has no agency of their
 * own). Everything downstream (ledger debit, prepaid/partial auto-payment,
 * notifying the client, pushing the new cap to Meta) is identical to an
 * agency's own approval — see finishLimitRequestApproval. */
export const approvePlatformLimitRequestFn = createServerFn({ method: 'POST' })
  .validator(limitApproveSchema)
  .handler(async ({ data }): Promise<{ ledger_id: string; payment_id: string | null }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const existing = await loadPlatformRequestForAction(admin, data.id)
    if (existing.status !== 'PENDING_PLATFORM_REVIEW') {
      throw new Error('Request is not awaiting platform review')
    }

    const { data: result, error } = await admin.rpc('approve_limit_request', {
      p_request_id: data.id,
      p_approved_amount: data.approved_amount_usd,
      p_approved_rate: data.approved_usd_rate,
      p_actor: actor.id,
      p_organization_id: existing.organization_id,
      p_admin_note: data.admin_note ?? null,
    })
    if (error) throw new Error(friendlyRpcError(error.message))
    const { ledger_id: ledgerId, payment_id: paymentId } = result as {
      ledger_id: string
      payment_id: string | null
      payment_ledger_id: string | null
    }

    await finishLimitRequestApproval(
      actor.id,
      data.id,
      data.approved_amount_usd,
      paymentId,
      existing.organization_id,
    )
    return { ledger_id: ledgerId, payment_id: paymentId }
  })

export const rejectPlatformLimitRequestFn = createServerFn({ method: 'POST' })
  .validator(limitRejectSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const existing = await loadPlatformRequestForAction(admin, data.id)
    if (existing.status !== 'PENDING_PLATFORM_REVIEW') {
      throw new Error('Request is not awaiting platform review')
    }

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
      .eq('status', 'PENDING_PLATFORM_REVIEW')
      .select('id, client_id, request_number')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new Error('Request is no longer awaiting platform review')
    }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: existing.organization_id,
      action: 'LIMIT_REQUEST_REJECTED',
      entityType: 'LIMIT_REQUEST',
      entityId: data.id,
      newValues: { rejection_reason: data.rejection_reason },
    })

    const rejected = updated[0] as { client_id: string; request_number: string }
    await notifyClientMembers(rejected.client_id, {
      type: 'LIMIT_REQUEST_REJECTED',
      title: 'Limit request rejected',
      message: `${rejected.request_number}: ${data.rejection_reason}`,
      entityType: 'LIMIT_REQUEST',
      entityId: data.id,
    })
    return { ok: true }
  })

/** Same staleness-refresh action as the agency's rebaseLimitRequestFn, for a
 * request currently sitting in PENDING_PLATFORM_REVIEW. */
export const rebasePlatformLimitRequestFn = createServerFn({ method: 'POST' })
  .validator(limitRequestIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const existing = await loadPlatformRequestForAction(admin, data.id)
    const { error } = await admin.rpc('rebase_limit_request', {
      p_request_id: data.id,
      p_actor: actor.id,
      p_organization_id: existing.organization_id,
    })
    if (error) throw new Error(friendlyRpcError(error.message))
    return { ok: true }
  })
