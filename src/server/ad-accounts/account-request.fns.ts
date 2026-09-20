import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyPlatformAdmins } from '@/server/notifications/notification.service'
import {
  accountRequestCreateSchema,
  accountRequestIdSchema,
} from '@/schemas/account-request'
import type { PlatformAccountRequestWithRefs } from '@/types/domain'

/**
 * Agency side of "Request Ad Account" (spec §4.4): the agency asks the
 * platform for a NEW pool account. No client and no existing ad account are
 * involved, so there is no agency-review step — the agency IS the requester,
 * and the request lands straight in the platform's queue
 * (server/platform/account-requests.fns.ts).
 *
 * Every read/write is scoped to the caller's OWN organization. The platform
 * decides; the agency can only ask, look at its own requests, and withdraw a
 * pending one.
 */

const SELECT = '*, fulfilled_ad_account:ad_accounts(id, account_code, name)'

/** This agency's own requests, newest first. */
export const listMyAccountRequestsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<PlatformAccountRequestWithRefs>> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('platform_account_requests')
      .select(SELECT)
      .eq('organization_id', actor.organizationId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return (data ?? []) as unknown as Array<PlatformAccountRequestWithRefs>
  },
)

export const createAccountRequestFn = createServerFn({ method: 'POST' })
  .validator(accountRequestCreateSchema)
  .handler(async ({ data }): Promise<{ id: string; request_number: string }> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: created, error } = await admin
      .from('platform_account_requests')
      .insert({
        organization_id: actor.organizationId,
        requested_by: actor.id,
        notes: data.notes,
      })
      .select('id, request_number')
      .single()
    if (error) throw new Error(error.message)
    const row = created as { id: string; request_number: string }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'PLATFORM_ACCOUNT_REQUESTED',
      entityType: 'PLATFORM_ACCOUNT_REQUEST',
      entityId: row.id,
      newValues: { request_number: row.request_number, notes: data.notes },
    })

    await notifyPlatformAdmins({
      type: 'AD_ACCOUNT_REQUESTED',
      title: 'New ad account request',
      message: `${actor.organizationName || 'An agency'} requested a new ad account (${row.request_number}).`,
      entityType: 'PLATFORM_ACCOUNT_REQUEST',
      entityId: row.id,
    })
    return row
  })

/** Withdraw a pending request before the platform acts on it. */
export const cancelAccountRequestFn = createServerFn({ method: 'POST' })
  .validator(accountRequestIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    // Scoped to the caller's own organization AND to PENDING in the update
    // itself, so a request that was fulfilled a moment ago (or belongs to
    // another agency) matches zero rows instead of being silently flipped.
    const { data: updated, error } = await admin
      .from('platform_account_requests')
      .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
      .eq('status', 'PENDING')
      .select('id, request_number')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new Error('This request is no longer pending, so it cannot be withdrawn.')
    }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'PLATFORM_ACCOUNT_REQUEST_CANCELLED',
      entityType: 'PLATFORM_ACCOUNT_REQUEST',
      entityId: data.id,
      newValues: { request_number: (updated[0] as { request_number: string }).request_number },
    })
    return { ok: true }
  })
