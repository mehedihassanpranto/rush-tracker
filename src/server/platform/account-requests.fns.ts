import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyAdmins } from '@/server/notifications/notification.service'
import { grantPoolAccountToOrganization } from '@/server/platform/pool-grant.service'
import {
  accountRequestFulfillSchema,
  accountRequestListSchema,
  accountRequestRejectSchema,
} from '@/schemas/account-request'
import type { PlatformAccountRequestWithRefs } from '@/types/domain'

/**
 * Platform side of "Request Ad Account" (spec §4.4 / §5 item 4). Every fn is
 * requirePlatformAdmin()-gated and spans every agency — a request belongs to
 * whichever agency asked, and the platform works one queue across all of them.
 *
 * Fulfilling is the same act as a manual Ad Account Pool grant
 * (grantPoolAccountToOrganization, shared with grantPoolAccountFn) plus
 * closing the request. Decisions are audited into the REQUESTING agency's
 * organization, not the platform's, so the agency sees in its own Audit Log
 * what the platform decided about its request — the same transparency
 * principle as the platform's "View agency data" screen.
 */

export interface PlatformAccountRequestRow extends PlatformAccountRequestWithRefs {
  organization: { id: string; name: string } | null
}

const SELECT =
  '*, fulfilled_ad_account:ad_accounts(id, account_code, name), organization:organizations(id, name)'

/** The queue across every agency. PENDING is oldest-first (work it in the
 * order it arrived); everything else is newest-first (a history). */
export const listPlatformAccountRequestsFn = createServerFn({ method: 'GET' })
  .validator(accountRequestListSchema)
  .handler(async ({ data }): Promise<Array<PlatformAccountRequestRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('platform_account_requests')
      .select(SELECT)
      .order('created_at', { ascending: data.status === 'PENDING' })
      .limit(200)
    if (data.status !== 'ALL') query = query.eq('status', data.status)
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return (rows ?? []) as unknown as Array<PlatformAccountRequestRow>
  })

/**
 * Assign a pool account to the requesting agency and close the request.
 *
 * The request is CLAIMED first (a conditional PENDING -> FULFILLED update),
 * then the grant is made, and the claim is undone if the grant fails. That
 * order is deliberate: doing the grant first would leave a granted account
 * behind a still-PENDING request if the second write failed, and two
 * platform admins fulfilling the same request at once would both pass a
 * plain status check. The conditional update lets exactly one of them win;
 * the UNIQUE constraint on platform_account_grants.ad_account_id is the
 * backstop when two different requests are pointed at the same account.
 */
export const fulfillAccountRequestFn = createServerFn({ method: 'POST' })
  .validator(accountRequestFulfillSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: req } = await admin
      .from('platform_account_requests')
      .select('id, organization_id, request_number, status')
      .eq('id', data.id)
      .maybeSingle()
    if (!req) throw new Error('Request not found')
    const request = req as {
      id: string
      organization_id: string
      request_number: string
      status: string
    }
    if (request.status !== 'PENDING') {
      throw new Error('This request is no longer pending.')
    }

    // A deactivated account should not be handed to an agency. (The manual
    // Grant action does not check this; an explicit fulfilment is a stronger
    // statement — "this account is ready for you" — so it does.)
    const { data: account } = await admin
      .from('ad_accounts')
      .select('status')
      .eq('id', data.ad_account_id)
      .maybeSingle()
    if ((account as { status: string } | null)?.status === 'INACTIVE') {
      throw new Error(
        'That account is deactivated — reactivate it before assigning it to an agency.',
      )
    }

    const { data: claimed, error: claimError } = await admin
      .from('platform_account_requests')
      .update({
        status: 'FULFILLED',
        fulfilled_ad_account_id: data.ad_account_id,
        decided_by: actor.id,
        decided_at: new Date().toISOString(),
      })
      .eq('id', data.id)
      .eq('status', 'PENDING')
      .select('id')
    if (claimError) throw new Error(claimError.message)
    if (!claimed || claimed.length === 0) {
      throw new Error('This request is no longer pending.')
    }

    let granted: { accountCode: string; accountName: string }
    try {
      granted = await grantPoolAccountToOrganization(
        admin,
        actor,
        data.ad_account_id,
        request.organization_id,
      )
    } catch (err) {
      const { error: revertError } = await admin
        .from('platform_account_requests')
        .update({
          status: 'PENDING',
          fulfilled_ad_account_id: null,
          decided_by: null,
          decided_at: null,
        })
        .eq('id', data.id)
        .eq('status', 'FULFILLED')
      if (revertError) {
        console.error(
          '[account-request] grant failed AND the claim could not be undone',
          data.id,
          revertError.message,
        )
      }
      throw err
    }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: request.organization_id,
      action: 'PLATFORM_ACCOUNT_REQUEST_FULFILLED',
      entityType: 'PLATFORM_ACCOUNT_REQUEST',
      entityId: data.id,
      newValues: {
        request_number: request.request_number,
        ad_account_id: data.ad_account_id,
        account_code: granted.accountCode,
      },
    })
    await notifyAdmins({
      organizationId: request.organization_id,
      type: 'AD_ACCOUNT_REQUEST_FULFILLED',
      title: 'Ad account assigned',
      message: `${request.request_number}: ${granted.accountCode} "${granted.accountName}" was assigned to your agency.`,
      entityType: 'AD_ACCOUNT',
      entityId: data.ad_account_id,
    })
    return { ok: true }
  })

export const rejectAccountRequestFn = createServerFn({ method: 'POST' })
  .validator(accountRequestRejectSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: updated, error } = await admin
      .from('platform_account_requests')
      .update({
        status: 'REJECTED',
        decision_reason: data.reason,
        decided_by: actor.id,
        decided_at: new Date().toISOString(),
      })
      .eq('id', data.id)
      .eq('status', 'PENDING')
      .select('id, organization_id, request_number')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new Error('This request is no longer pending.')
    }
    const row = updated[0] as { organization_id: string; request_number: string }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: row.organization_id,
      action: 'PLATFORM_ACCOUNT_REQUEST_REJECTED',
      entityType: 'PLATFORM_ACCOUNT_REQUEST',
      entityId: data.id,
      newValues: { request_number: row.request_number, decision_reason: data.reason },
    })
    await notifyAdmins({
      organizationId: row.organization_id,
      type: 'AD_ACCOUNT_REQUEST_REJECTED',
      title: 'Ad account request declined',
      message: `${row.request_number}: ${data.reason}`,
      entityType: 'PLATFORM_ACCOUNT_REQUEST',
      entityId: data.id,
    })
    return { ok: true }
  })
