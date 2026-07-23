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
import { signProofUrl, uploadProof } from '@/server/storage/storage.service'
import { dec, formatBdt } from '@/lib/money/money'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  paymentApproveSchema,
  paymentIdSchema,
  paymentListSchema,
  paymentRejectSchema,
  paymentSubmitSchema,
} from '@/schemas/payment'
import type {
  DueSummary,
  Payment,
  PaymentWithClient,
} from '@/types/domain'

const PROOF_ENTITY = 'PAYMENT_PROOF'

function friendlyRpcError(message: string): string {
  return message.replace(/^.*?:\s*/, '').trim() || message
}

async function currentDue(clientId: string): Promise<string> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin.rpc('client_financials', {
    p_client_id: clientId,
  })
  const row = (data as Array<{ current_due: string }> | null)?.[0]
  return row?.current_due ?? '0'
}

async function pendingPaymentsTotal(clientId: string): Promise<string> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('payments')
    .select('amount_bdt')
    .eq('client_id', clientId)
    .eq('status', 'PENDING')
  let total = dec(0)
  for (const p of (data ?? []) as Array<{ amount_bdt: string }>) {
    total = total.plus(p.amount_bdt)
  }
  return total.toFixed(2)
}

async function proofPathForPayment(paymentId: string): Promise<string | null> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('attachments')
    .select('storage_path')
    .eq('entity_type', PROOF_ENTITY)
    .eq('entity_id', paymentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { storage_path: string } | null)?.storage_path ?? null
}

// ===========================================================================
// Client
// ===========================================================================

export const getMyDueFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DueSummary> => {
    const { membership } = await requireClientMembership()
    const due = await currentDue(membership.clientId)
    const pending = await pendingPaymentsTotal(membership.clientId)
    const outstanding = dec(due).minus(pending)
    return {
      current_due: dec(due).toFixed(2),
      pending_total: pending,
      outstanding: (outstanding.isNegative() ? dec(0) : outstanding).toFixed(2),
    }
  },
)

export const listMyPaymentsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<Payment>> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('payments')
      .select(
        'id, payment_number, client_id, payment_request_id, amount_bdt, payment_method, transaction_reference, status, submitted_at, reviewed_at, admin_note, rejection_reason, created_at',
      )
      .eq('client_id', membership.clientId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data as Array<Payment>
  },
)

/**
 * Submit a payment WITH its proof (spec §42, §44). Creates a PENDING payment —
 * due does not change until an admin approves it. Blocks accidental
 * overpayment beyond the outstanding amount (spec §49).
 */
export const submitPaymentFn = createServerFn({ method: 'POST' })
  .validator(paymentSubmitSchema)
  .handler(async ({ data }): Promise<Payment> => {
    const { user, membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    // Overpayment guard against due minus already-pending payments.
    const due = await currentDue(membership.clientId)
    const pending = await pendingPaymentsTotal(membership.clientId)
    const outstanding = dec(due).minus(pending)
    if (outstanding.lte(0)) {
      throw new Error('You have no outstanding due to pay right now')
    }
    if (dec(data.amount_bdt).gt(outstanding)) {
      throw new Error(
        `Amount exceeds your outstanding due of ${outstanding.toFixed(2)} BDT`,
      )
    }

    // If linked to a payment request, verify it belongs to this client.
    if (data.payment_request_id) {
      const { data: pr } = await admin
        .from('payment_requests')
        .select('id')
        .eq('id', data.payment_request_id)
        .eq('client_id', membership.clientId)
        .maybeSingle()
      if (!pr) throw new Error('Payment request not found')
    }

    const { data: payment, error } = await admin
      .from('payments')
      .insert({
        client_id: membership.clientId,
        payment_request_id: data.payment_request_id ?? null,
        amount_bdt: data.amount_bdt,
        payment_method: data.payment_method,
        transaction_reference: data.transaction_reference ?? null,
        submitted_by: user.id,
        status: 'PENDING',
      })
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    // Attach proof; roll back the payment if storage/attachment fails so we
    // never leave a proofless payment.
    try {
      const stored = await uploadProof({
        folder: `payments/${payment.id}`,
        mimeType: data.mime_type,
        dataBase64: data.data_base64,
      })
      const { error: attErr } = await admin.from('attachments').insert({
        entity_type: PROOF_ENTITY,
        entity_id: payment.id,
        storage_bucket: 'proofs',
        storage_path: stored.storage_path,
        original_file_name: data.file_name,
        mime_type: data.mime_type,
        file_size: stored.file_size,
        uploaded_by: user.id,
      })
      if (attErr) throw new Error(attErr.message)
    } catch (err) {
      await admin.from('payments').delete().eq('id', payment.id)
      throw err instanceof Error ? err : new Error('Failed to attach proof')
    }

    // Mark the linked request as submitted (spec §47).
    if (data.payment_request_id) {
      await admin
        .from('payment_requests')
        .update({ status: 'PAYMENT_SUBMITTED' })
        .eq('id', data.payment_request_id)
        .in('status', ['REQUESTED', 'PARTIALLY_PAID'])
    }

    await writeAudit({
      actorUserId: user.id,
      action: 'PAYMENT_SUBMITTED',
      entityType: 'PAYMENT',
      entityId: payment.id,
      newValues: { amount_bdt: data.amount_bdt, method: data.payment_method },
    })

    await notifyAdmins({
      type: 'PAYMENT_SUBMITTED',
      title: 'Payment submitted',
      message: `${payment.payment_number}: ${formatBdt(
        data.amount_bdt,
      )} awaiting verification`,
      entityType: 'PAYMENT',
      entityId: payment.id,
    })
    return payment as Payment
  })

export const cancelMyPaymentFn = createServerFn({ method: 'POST' })
  .validator(paymentIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { user, membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()
    const { data: updated, error } = await admin
      .from('payments')
      .update({ status: 'CANCELLED' })
      .eq('id', data.id)
      .eq('client_id', membership.clientId)
      .eq('status', 'PENDING')
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new Error('Payment can no longer be cancelled')
    }
    await writeAudit({
      actorUserId: user.id,
      action: 'PAYMENT_CANCELLED',
      entityType: 'PAYMENT',
      entityId: data.id,
    })
    return { ok: true }
  })

export const getMyPaymentProofUrlFn = createServerFn({ method: 'POST' })
  .validator(paymentIdSchema)
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()
    const { data: pay } = await admin
      .from('payments')
      .select('id')
      .eq('id', data.id)
      .eq('client_id', membership.clientId)
      .maybeSingle()
    if (!pay) throw new Error('Payment not found')
    const path = await proofPathForPayment(data.id)
    if (!path) return { url: null }
    return { url: await signProofUrl(path) }
  })

// ===========================================================================
// Admin
// ===========================================================================

export const listPaymentsFn = createServerFn({ method: 'GET' })
  .validator(paymentListSchema)
  .handler(async ({ data }): Promise<Array<PaymentWithClient>> => {
    await requireAdmin(PERMISSIONS.PAYMENTS_VIEW)
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('payments')
      .select(
        'id, payment_number, client_id, payment_request_id, amount_bdt, payment_method, transaction_reference, status, submitted_at, reviewed_at, admin_note, rejection_reason, created_at, client:clients(id, client_code, name)',
      )
      .order('created_at', { ascending: false })
    if (data.status !== 'ALL') query = query.eq('status', data.status)
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return rows as unknown as Array<PaymentWithClient>
  })

export interface PaymentDetail extends PaymentWithClient {
  has_proof: boolean
}

export const getPaymentDetailFn = createServerFn({ method: 'GET' })
  .validator(paymentIdSchema)
  .handler(async ({ data }): Promise<PaymentDetail> => {
    await requireAdmin(PERMISSIONS.PAYMENTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: pay, error } = await admin
      .from('payments')
      .select(
        'id, payment_number, client_id, payment_request_id, amount_bdt, payment_method, transaction_reference, status, submitted_at, reviewed_at, admin_note, rejection_reason, created_at, client:clients(id, client_code, name)',
      )
      .eq('id', data.id)
      .single()
    if (error) throw new Error(error.message)
    const path = await proofPathForPayment(data.id)
    return { ...(pay as unknown as PaymentWithClient), has_proof: path !== null }
  })

export const getPaymentProofUrlFn = createServerFn({ method: 'POST' })
  .validator(paymentIdSchema)
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    await requireAdmin(PERMISSIONS.PAYMENTS_VIEW)
    const path = await proofPathForPayment(data.id)
    if (!path) return { url: null }
    return { url: await signProofUrl(path) }
  })

export const approvePaymentFn = createServerFn({ method: 'POST' })
  .validator(paymentApproveSchema)
  .handler(async ({ data }): Promise<{ ledger_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.PAYMENTS_APPROVE)
    const admin = getSupabaseAdminClient()

    if (data.admin_note) {
      await admin
        .from('payments')
        .update({ admin_note: data.admin_note })
        .eq('id', data.id)
        .eq('status', 'PENDING')
    }

    const { data: ledgerId, error } = await admin.rpc('approve_payment', {
      p_payment_id: data.id,
      p_actor: actor.id,
    })
    if (error) throw new Error(friendlyRpcError(error.message))

    const { data: pay } = await admin
      .from('payments')
      .select('client_id, payment_number, amount_bdt')
      .eq('id', data.id)
      .maybeSingle()
    if (pay) {
      const p = pay as {
        client_id: string
        payment_number: string
        amount_bdt: string
      }
      await notifyClientMembers(p.client_id, {
        type: 'PAYMENT_APPROVED',
        title: 'Payment approved',
        message: `${p.payment_number}: ${formatBdt(p.amount_bdt)} credited`,
        entityType: 'PAYMENT',
        entityId: data.id,
      })
    }
    return { ledger_id: ledgerId as string }
  })

export const rejectPaymentFn = createServerFn({ method: 'POST' })
  .validator(paymentRejectSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.PAYMENTS_APPROVE)
    const admin = getSupabaseAdminClient()
    const { data: updated, error } = await admin
      .from('payments')
      .update({
        status: 'REJECTED',
        rejection_reason: data.rejection_reason,
        reviewed_by: actor.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', data.id)
      .eq('status', 'PENDING')
      .select('id, client_id, payment_number')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      throw new Error('Payment is no longer pending')
    }
    await writeAudit({
      actorUserId: actor.id,
      action: 'PAYMENT_REJECTED',
      entityType: 'PAYMENT',
      entityId: data.id,
      newValues: { rejection_reason: data.rejection_reason },
    })

    const rejected = updated[0] as {
      client_id: string
      payment_number: string
    }
    await notifyClientMembers(rejected.client_id, {
      type: 'PAYMENT_REJECTED',
      title: 'Payment rejected',
      message: `${rejected.payment_number}: ${data.rejection_reason}`,
      entityType: 'PAYMENT',
      entityId: data.id,
    })
    return { ok: true }
  })
