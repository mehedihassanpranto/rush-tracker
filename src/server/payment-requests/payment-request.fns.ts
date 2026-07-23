import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import {
  requireAdmin,
  requireClientMembership,
} from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyClientMembers } from '@/server/notifications/notification.service'
import { formatBdt } from '@/lib/money/money'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  paymentIdSchema,
  paymentRequestCreateSchema,
} from '@/schemas/payment'
import type {
  PaymentRequest,
  PaymentRequestWithClient,
} from '@/types/domain'

// ===========================================================================
// Admin
// ===========================================================================

export const createPaymentRequestFn = createServerFn({ method: 'POST' })
  .validator(paymentRequestCreateSchema)
  .handler(async ({ data }): Promise<PaymentRequest> => {
    const actor = await requireAdmin(PERMISSIONS.PAYMENT_REQUESTS_CREATE)
    const admin = getSupabaseAdminClient()

    const { data: created, error } = await admin
      .from('payment_requests')
      .insert({
        client_id: data.client_id,
        requested_amount_bdt: data.requested_amount_bdt,
        message: data.message ?? null,
        due_date: data.due_date ?? null,
        created_by: actor.id,
        status: 'REQUESTED',
      })
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'PAYMENT_REQUEST_CREATED',
      entityType: 'PAYMENT_REQUEST',
      entityId: created.id,
      newValues: {
        client_id: data.client_id,
        requested_amount_bdt: data.requested_amount_bdt,
      },
    })

    await notifyClientMembers(data.client_id, {
      type: 'PAYMENT_REQUEST_CREATED',
      title: 'Payment requested',
      message: `${created.request_number}: ${formatBdt(
        data.requested_amount_bdt,
      )} requested`,
      entityType: 'PAYMENT_REQUEST',
      entityId: created.id,
    })
    return created as PaymentRequest
  })

export const listPaymentRequestsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid().optional() }))
  .handler(async ({ data }): Promise<Array<PaymentRequestWithClient>> => {
    await requireAdmin(PERMISSIONS.PAYMENTS_VIEW)
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('payment_requests')
      .select(
        'id, request_number, client_id, requested_amount_bdt, status, message, due_date, created_at, client:clients(id, client_code, name)',
      )
      .order('created_at', { ascending: false })
      .limit(200)
    if (data.client_id) query = query.eq('client_id', data.client_id)
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return rows as unknown as Array<PaymentRequestWithClient>
  })

export const cancelPaymentRequestFn = createServerFn({ method: 'POST' })
  .validator(paymentIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.PAYMENT_REQUESTS_CREATE)
    const admin = getSupabaseAdminClient()
    const { data: updated, error } = await admin
      .from('payment_requests')
      .update({ status: 'CANCELLED' })
      .eq('id', data.id)
      .in('status', ['REQUESTED', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID'])
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new Error('This request can no longer be cancelled')
    }
    await writeAudit({
      actorUserId: actor.id,
      action: 'PAYMENT_REQUEST_CANCELLED',
      entityType: 'PAYMENT_REQUEST',
      entityId: data.id,
    })
    return { ok: true }
  })

// ===========================================================================
// Client
// ===========================================================================

/** Open payment requests for the signed-in client (spec §48). */
export const listMyPaymentRequestsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<PaymentRequest>> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('payment_requests')
      .select(
        'id, request_number, client_id, requested_amount_bdt, status, message, due_date, created_at',
      )
      .eq('client_id', membership.clientId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data as Array<PaymentRequest>
  },
)
