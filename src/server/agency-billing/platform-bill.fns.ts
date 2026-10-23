import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireSuperAdmin } from '@/server/auth/guards.server'
import { UserError } from '@/lib/errors/user-error'
import { dec, formatBdt } from '@/lib/money/money'
import { signProofUrl, uploadProof } from '@/server/storage/storage.service'
import { notifyPlatformAdmins } from '@/server/notifications/notification.service'
import { notifyTelegram } from '@/server/telegram/telegram.service'
import { inventoryRpcError } from '@/server/platform/usd-inventory.service'
import { buildAgencyStatement } from '@/server/platform/agency-statement.service'
import { ALLOWED_PROOF_MIME, MAX_PROOF_BYTES } from '@/schemas/limit-request'
import type { AgencyStatementRow } from '@/server/platform/agency-statement.service'

/**
 * /agency/platform-billing — what an agency owes the PLATFORM (pool-account
 * limits it approved × its USD rate, migration 000064) and paying it
 * (migration 000066). Owner's rule (2026-10-23): the agency's SUPER_ADMIN only.
 *
 * Always scoped to the caller's own organization. Shows the agency its own
 * rate and charges, never the platform's cost, margin, suppliers or stock.
 */

export const PROOF_ENTITY_AGENCY_PAYMENT = 'AGENCY_PAYMENT_SUBMISSION'
const INSTRUCTIONS_KEY = 'agency_payment_instructions'
const money = (v: unknown): string => (v == null ? '0.00' : dec(v as string | number).toFixed(2))

export interface MyPlatformBill {
  owed_bdt: string
  advance_bdt: string
  current_rate: string | null
  pending_rate_usd: string
  pending_rate_count: number
  pending_payments_bdt: string
  pending_payments_count: number
  instructions: string | null
}

export const getMyPlatformBillFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MyPlatformBill> => {
    const user = await requireSuperAdmin()
    const admin = getSupabaseAdminClient()
    const org = user.organizationId
    const [summary, pending, settings] = await Promise.all([
      admin.from('agency_billing_summary').select('current_rate, owed_bdt, advance_bdt, pending_rate, pending_usd').eq('organization_id', org).maybeSingle(),
      admin.from('agency_payment_submissions').select('bdt_amount').eq('organization_id', org).eq('status', 'PENDING'),
      admin.from('platform_settings').select('value').eq('key', INSTRUCTIONS_KEY).maybeSingle(),
    ])
    if (summary.error) throw new Error(summary.error.message)
    if (pending.error) throw new Error(pending.error.message)
    const s = summary.data as Record<string, unknown> | null
    const p = (pending.data ?? []) as Array<{ bdt_amount: number }>
    return {
      owed_bdt: money(s?.owed_bdt),
      advance_bdt: money(s?.advance_bdt),
      current_rate: s?.current_rate == null ? null : dec(s.current_rate as number).toFixed(2),
      pending_rate_usd: money(s?.pending_usd),
      pending_rate_count: Number(s?.pending_rate ?? 0),
      pending_payments_bdt: p.reduce((t, r) => t.plus(r.bdt_amount), dec(0)).toFixed(2),
      pending_payments_count: p.length,
      instructions: ((settings.data as { value: string | null } | null)?.value ?? '').trim() || null,
    }
  },
)

export interface MyPlatformCharge {
  id: string
  reference_id: string
  kind: 'LIMIT_APPROVAL' | 'OPENING_BALANCE'
  at: string
  request_number: string | null
  ad_account: { account_code: string; name: string } | null
  usd_amount: string | null
  rate: string | null
  bdt_amount: string | null
  status: 'PENDING_RATE' | 'POSTED' | 'REVERSED'
  reversal_reason: string | null
}

export const listMyPlatformChargesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<MyPlatformCharge>> => {
    const user = await requireSuperAdmin()
    const { data, error } = await getSupabaseAdminClient()
      .from('agency_charges')
      .select('id, reference_id, kind, usd_amount, rate, bdt_amount, event_at, status, notes, reversal_reason, ad_account:ad_accounts(account_code, name)')
      .eq('organization_id', user.organizationId)
      .order('event_at', { ascending: false })
      .limit(500)
    if (error) throw new Error(error.message)
    return (data ?? []).map((raw) => {
      const c = raw as unknown as Record<string, unknown> & { ad_account: MyPlatformCharge['ad_account'] }
      return {
        id: c.id as string,
        reference_id: c.reference_id as string,
        kind: c.kind as MyPlatformCharge['kind'],
        at: c.event_at as string,
        request_number: c.kind === 'LIMIT_APPROVAL' ? ((c.notes as string | null) ?? null) : null,
        ad_account: c.ad_account,
        usd_amount: c.usd_amount == null ? null : money(c.usd_amount),
        rate: c.rate == null ? null : dec(c.rate as number).toFixed(2),
        bdt_amount: c.bdt_amount == null ? null : money(c.bdt_amount),
        status: c.status as MyPlatformCharge['status'],
        reversal_reason: (c.reversal_reason as string | null) ?? null,
      }
    })
  },
)

export interface MyPlatformPayment {
  /** Submission id when the agency submitted it; payment id when the platform recorded it. */
  id: string
  source: 'SUBMITTED' | 'RECORDED_BY_PLATFORM'
  reference_id: string
  at: string
  bdt_amount: string
  /** What the platform booked, when it differs from what was submitted. */
  approved_bdt: string | null
  method: string | null
  external_reference: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVERSED'
  rejection_reason: string | null
  advance_bdt: string | null
  has_proof: boolean
}

export const listMyPlatformPaymentsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<MyPlatformPayment>> => {
    const user = await requireSuperAdmin()
    const admin = getSupabaseAdminClient()
    const org = user.organizationId
    const [subs, pays, proofs] = await Promise.all([
      admin
        .from('agency_payment_submissions')
        .select('id, reference_id, bdt_amount, approved_bdt, method, external_reference, paid_at, status, rejection_reason, agency_payment:agency_payments!agency_payment_submissions_agency_payment_id_fkey(advance_bdt, status)')
        .eq('organization_id', org)
        .order('paid_at', { ascending: false })
        .limit(300),
      admin
        .from('agency_payments')
        .select('id, reference_id, bdt_amount, advance_bdt, method, external_reference, received_at, status, submission_id')
        .eq('organization_id', org)
        .is('submission_id', null)
        .order('received_at', { ascending: false })
        .limit(300),
      admin.from('attachments').select('entity_id').eq('organization_id', org).eq('entity_type', PROOF_ENTITY_AGENCY_PAYMENT),
    ])
    for (const r of [subs, pays, proofs]) if (r.error) throw new Error(r.error.message)
    const withProof = new Set((proofs.data ?? []).map((a) => a.entity_id as string))
    const rows: Array<MyPlatformPayment> = [
      ...(subs.data ?? []).map((raw) => {
        const s = raw as unknown as Record<string, unknown> & { agency_payment: { advance_bdt: number; status: string } | null }
        const reversed = s.agency_payment?.status === 'REVERSED'
        return {
          id: s.id as string,
          source: 'SUBMITTED' as const,
          reference_id: s.reference_id as string,
          at: s.paid_at as string,
          bdt_amount: money(s.bdt_amount),
          approved_bdt: s.approved_bdt == null ? null : money(s.approved_bdt),
          method: (s.method as string | null) ?? null,
          external_reference: (s.external_reference as string | null) ?? null,
          status: reversed ? ('REVERSED' as const) : (s.status as MyPlatformPayment['status']),
          rejection_reason: (s.rejection_reason as string | null) ?? null,
          advance_bdt: s.agency_payment ? money(s.agency_payment.advance_bdt) : null,
          has_proof: withProof.has(s.id as string),
        }
      }),
      ...(pays.data ?? []).map((p) => ({
        id: p.id as string,
        source: 'RECORDED_BY_PLATFORM' as const,
        reference_id: p.reference_id as string,
        at: p.received_at as string,
        bdt_amount: money(p.bdt_amount),
        approved_bdt: null,
        method: (p.method as string | null) ?? null,
        external_reference: (p.external_reference as string | null) ?? null,
        status: p.status === 'REVERSED' ? ('REVERSED' as const) : ('APPROVED' as const),
        rejection_reason: null,
        advance_bdt: money(p.advance_bdt),
        has_proof: false,
      })),
    ]
    return rows.sort((a, b) => b.at.localeCompare(a.at))
  },
)

const submitSchema = z.object({
  bdt_amount: z.coerce.number().positive('Enter the amount you paid').max(1_000_000_000_000),
  method: z.string().trim().min(1, 'Say how you paid').max(100),
  external_reference: z.string().trim().max(120).optional(),
  paid_at: z.iso.datetime({ offset: true, message: 'Enter when you paid' }),
  note: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().trim().min(8).max(100),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.enum(ALLOWED_PROOF_MIME),
  data_base64: z.string().min(1),
})

/** Submit a payment to the platform with its proof, for the platform to approve. */
export const submitPlatformPaymentFn = createServerFn({ method: 'POST' })
  .validator(submitSchema)
  .handler(async ({ data }): Promise<{ reference_id: string; duplicate: boolean }> => {
    const user = await requireSuperAdmin()
    const admin = getSupabaseAdminClient()
    // Base64 is 4/3 the size of the file; refuse before decoding anything big.
    if (Math.floor((data.data_base64.length * 3) / 4) > MAX_PROOF_BYTES + 4) {
      throw new UserError('The proof file is too large (3 MB at most)')
    }

    const { data: row, error } = await admin.rpc('submit_agency_payment', {
      p_actor: user.id,
      p_org: user.organizationId,
      p_bdt: dec(data.bdt_amount).toDecimalPlaces(2).toNumber(),
      p_method: data.method,
      p_reference: data.external_reference ?? null,
      p_paid_at: data.paid_at,
      p_note: data.note ?? null,
      p_key: data.idempotency_key,
    })
    if (error) throw inventoryRpcError(error.message)
    const sub = row as { id: string; reference_id: string; duplicate: boolean; bdt_amount: number }
    if (sub.duplicate) return { reference_id: sub.reference_id, duplicate: true }

    // The proof is required: if storing it fails, withdraw the submission
    // rather than leave the platform a payment it can't check.
    try {
      const stored = await uploadProof({
        folder: `agency-payments/${sub.id}`,
        mimeType: data.mime_type,
        dataBase64: data.data_base64,
      })
      const { error: attErr } = await admin.from('attachments').insert({
        entity_type: PROOF_ENTITY_AGENCY_PAYMENT,
        entity_id: sub.id,
        storage_bucket: 'proofs',
        storage_path: stored.storage_path,
        original_file_name: data.file_name,
        mime_type: data.mime_type,
        file_size: stored.file_size,
        uploaded_by: user.id,
        organization_id: user.organizationId,
      })
      if (attErr) throw new Error(attErr.message)
    } catch (err) {
      await admin.rpc('cancel_agency_payment_submission', { p_actor: user.id, p_org: user.organizationId, p_id: sub.id })
      throw err instanceof Error ? err : new Error('Failed to attach the proof')
    }

    const text = `${user.organizationName ?? 'An agency'} submitted a payment of ${formatBdt(money(sub.bdt_amount))} (${sub.reference_id}) — review it in Finance & Accounts → Agencies.`
    await notifyPlatformAdmins({
      type: 'AGENCY_PAYMENT_SUBMITTED',
      title: 'Agency payment to review',
      message: text,
      entityType: 'AGENCY_PAYMENT_SUBMISSION',
      entityId: sub.id,
    })
    await notifyTelegram({
      eventType: 'agency_payment.submitted',
      recipient: { type: 'platform_admin' },
      text: `💳 ${text}`,
      payload: { submission_id: sub.id, reference_id: sub.reference_id },
    })
    return { reference_id: sub.reference_id, duplicate: false }
  })

export const cancelPlatformPaymentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const user = await requireSuperAdmin()
    const { error } = await getSupabaseAdminClient().rpc('cancel_agency_payment_submission', {
      p_actor: user.id,
      p_org: user.organizationId,
      p_id: data.id,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

/** A 60-second link to the proof of one of the agency's own submissions. */
export const getMyPaymentProofUrlFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<string> => {
    const user = await requireSuperAdmin()
    const { data: att } = await getSupabaseAdminClient()
      .from('attachments')
      .select('storage_path')
      .eq('entity_type', PROOF_ENTITY_AGENCY_PAYMENT)
      .eq('entity_id', data.id)
      .eq('organization_id', user.organizationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!att) throw new UserError('No proof found for that payment')
    return signProofUrl(att.storage_path as string)
  })

export const getMyPlatformStatementFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ agency: string; rows: Array<AgencyStatementRow> }> => {
    const user = await requireSuperAdmin()
    return buildAgencyStatement(getSupabaseAdminClient(), user.organizationId)
  },
)
