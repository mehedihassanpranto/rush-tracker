import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { dec, formatBdt } from '@/lib/money/money'
import { UserError } from '@/lib/errors/user-error'
import { signProofUrl } from '@/server/storage/storage.service'
import { notifySuperAdmins } from '@/server/notifications/notification.service'
import { inventoryRpcError } from '@/server/platform/usd-inventory.service'
import { organizationId } from '@/schemas/organization'
import { reversalSchema } from '@/schemas/usd-inventory'

/**
 * Platform Finance & Accounts → Agencies (Finance v2 Milestone 4, migration
 * 000064). What each agency owes the platform: every limit approved on a
 * pool account is charged at the agency's USD rate (by a database trigger on
 * the approval, never from here), payments settle it, money paid ahead is an
 * advance. Platform admins only — an agency never sees its rate history or
 * the platform's books through this.
 */

const bdt = (v: unknown): string => (v == null ? '0.00' : dec(v as string | number).toFixed(2))

const reason = z.string().trim().min(1, 'Give a reason').max(500)
const isoDateTime = z.iso.datetime({ offset: true, message: 'Enter a valid date and time' })

export interface AgencyBillingRow {
  organization_id: string
  name: string
  subscription_status: string
  current_rate: string | null
  billed_usd: string
  billed_bdt: string
  paid_bdt: string
  owed_bdt: string
  advance_bdt: string
  pending_rate: number
  pending_usd: string
}

export const listAgencyBillingFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<AgencyBillingRow>> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient().from('agency_billing_summary').select('*')
    if (error) throw new Error(error.message)
    return (data ?? [])
      .map((r) => ({
        organization_id: r.organization_id as string,
        name: r.name as string,
        subscription_status: r.subscription_status as string,
        current_rate: r.current_rate == null ? null : dec(r.current_rate).toFixed(4),
        billed_usd: bdt(r.billed_usd),
        billed_bdt: bdt(r.billed_bdt),
        paid_bdt: bdt(r.paid_bdt),
        owed_bdt: bdt(r.owed_bdt),
        advance_bdt: bdt(r.advance_bdt),
        pending_rate: Number(r.pending_rate ?? 0),
        pending_usd: bdt(r.pending_usd),
      }))
      .sort(
        (a, b) =>
          dec(b.owed_bdt).comparedTo(dec(a.owed_bdt)) ||
          dec(b.billed_bdt).comparedTo(dec(a.billed_bdt)) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      )
  },
)

export interface AgencyLedgerRow {
  id: string
  type: 'CHARGE' | 'OPENING_BALANCE' | 'PAYMENT'
  reference_id: string
  at: string
  status: string
  usd_amount: string | null
  rate: string | null
  bdt_amount: string | null
  /** Payments: what settled the receivable and what became an advance. */
  applied_bdt: string | null
  advance_bdt: string | null
  detail: string | null
  reversal_reason: string | null
}

/** One agency's charges and payments, newest first. */
export const listAgencyLedgerFn = createServerFn({ method: 'GET' })
  .validator(z.object({ organization_id: organizationId }))
  .handler(async ({ data }): Promise<Array<AgencyLedgerRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const [charges, payments] = await Promise.all([
      admin
        .from('agency_charges')
        .select('id, reference_id, kind, usd_amount, rate, bdt_amount, event_at, status, notes, reversal_reason, ad_account:ad_accounts(account_code, name)')
        .eq('organization_id', data.organization_id)
        .order('event_at', { ascending: false })
        .limit(300),
      admin
        .from('agency_payments')
        .select('id, reference_id, bdt_amount, applied_bdt, advance_bdt, received_at, status, method, is_internal, external_reference, notes, reversal_reason')
        .eq('organization_id', data.organization_id)
        .order('received_at', { ascending: false })
        .limit(300),
    ])
    if (charges.error) throw new Error(charges.error.message)
    if (payments.error) throw new Error(payments.error.message)

    const rows: Array<AgencyLedgerRow> = [
      ...(charges.data ?? []).map((raw) => {
        const c = raw as unknown as Record<string, unknown> & { ad_account: { account_code: string; name: string } | null }
        return {
          id: c.id as string,
          type: c.kind === 'OPENING_BALANCE' ? ('OPENING_BALANCE' as const) : ('CHARGE' as const),
          reference_id: c.reference_id as string,
          at: c.event_at as string,
          status: c.status as string,
          usd_amount: c.usd_amount == null ? null : bdt(c.usd_amount),
          rate: c.rate == null ? null : dec(c.rate as number).toFixed(4),
          bdt_amount: c.bdt_amount == null ? null : bdt(c.bdt_amount),
          applied_bdt: null,
          advance_bdt: null,
          detail: c.ad_account
            ? `${c.ad_account.account_code} · ${c.ad_account.name}${c.notes ? ` · ${String(c.notes)}` : ''}`
            : ((c.notes as string | null) ?? null),
          reversal_reason: (c.reversal_reason as string | null) ?? null,
        }
      }),
      ...(payments.data ?? []).map((p) => ({
        id: p.id as string,
        type: 'PAYMENT' as const,
        reference_id: p.reference_id as string,
        at: p.received_at as string,
        status: p.status as string,
        usd_amount: null,
        rate: null,
        bdt_amount: bdt(p.bdt_amount),
        applied_bdt: bdt(p.applied_bdt),
        advance_bdt: bdt(p.advance_bdt),
        detail:
          [p.method, p.external_reference, p.is_internal ? 'internal' : null, p.notes].filter(Boolean).join(' · ') || null,
        reversal_reason: (p.reversal_reason as string | null) ?? null,
      })),
    ]
    return rows.sort((a, b) => b.at.localeCompare(a.at))
  })

export interface AgencyRateRow {
  id: string
  rate: string
  effective_from: string
  note: string | null
}

export const listAgencyRatesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ organization_id: organizationId }))
  .handler(async ({ data }): Promise<Array<AgencyRateRow>> => {
    await requirePlatformAdmin()
    const { data: rows, error } = await getSupabaseAdminClient()
      .from('agency_usd_rates')
      .select('id, rate, effective_from, note')
      .eq('organization_id', data.organization_id)
      .order('effective_from', { ascending: false })
    if (error) throw new Error(error.message)
    return (rows ?? []).map((r) => ({
      id: r.id as string,
      rate: dec(r.rate).toFixed(4),
      effective_from: r.effective_from as string,
      note: (r.note as string | null) ?? null,
    }))
  })

/** The earliest charge still waiting for a rate — the rate dialog defaults
 * its start date to it, so setting a rate prices everything waiting. */
export const getEarliestPendingChargeFn = createServerFn({ method: 'GET' })
  .validator(z.object({ organization_id: organizationId }))
  .handler(async ({ data }): Promise<string | null> => {
    await requirePlatformAdmin()
    const { data: row } = await getSupabaseAdminClient()
      .from('agency_charges')
      .select('event_at')
      .eq('organization_id', data.organization_id)
      .eq('status', 'PENDING_RATE')
      .order('event_at')
      .limit(1)
      .maybeSingle()
    return (row?.event_at as string | undefined) ?? null
  })

export const setAgencyRateFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      organization_id: organizationId,
      rate: z.coerce.number().positive('Enter a rate above zero').max(10_000),
      effective_from: z.iso.date({ message: 'Enter a valid date' }),
      note: z.string().trim().max(500).optional(),
    }),
  )
  .handler(async ({ data }): Promise<{ priced: number }> => {
    const actor = await requirePlatformAdmin()
    const { data: r, error } = await getSupabaseAdminClient().rpc('set_agency_rate', {
      p_actor: actor.id,
      p_org: data.organization_id,
      p_rate: data.rate,
      p_from: data.effective_from,
      p_note: data.note ?? null,
    })
    if (error) throw inventoryRpcError(error.message)
    return { priced: (r as { priced: number }).priced }
  })

export const recordAgencyPaymentFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      organization_id: organizationId,
      bdt_amount: z.coerce.number().positive('Enter the BDT received').max(1_000_000_000_000),
      received_at: isoDateTime,
      method: z.string().trim().max(100).optional(),
      is_internal: z.boolean(),
      external_reference: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(1000).optional(),
      idempotency_key: z.string().trim().min(8).max(100),
    }),
  )
  .handler(async ({ data }): Promise<{ applied_bdt: string; advance_bdt: string; duplicate: boolean }> => {
    const actor = await requirePlatformAdmin()
    const { data: r, error } = await getSupabaseAdminClient().rpc('record_agency_payment', {
      p_actor: actor.id,
      p_org: data.organization_id,
      p_bdt: dec(data.bdt_amount).toDecimalPlaces(2).toNumber(),
      p_received_at: data.received_at,
      p_method: data.method ?? null,
      p_is_internal: data.is_internal,
      p_reference: data.external_reference ?? null,
      p_notes: data.notes ?? null,
      p_key: data.idempotency_key,
    })
    if (error) throw inventoryRpcError(error.message)
    const row = r as { applied_bdt: unknown; advance_bdt: unknown; duplicate: boolean }
    return { applied_bdt: bdt(row.applied_bdt), advance_bdt: bdt(row.advance_bdt), duplicate: row.duplicate }
  })

export const recordAgencyOpeningBalanceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      organization_id: organizationId,
      bdt_amount: z.coerce.number().refine((v) => v !== 0, 'Enter a non-zero amount'),
      as_of: isoDateTime,
      notes: reason,
    }),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('record_agency_opening_balance', {
      p_actor: actor.id,
      p_org: data.organization_id,
      p_bdt: dec(data.bdt_amount).toDecimalPlaces(2).toNumber(),
      p_as_of: data.as_of,
      p_notes: data.notes,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

export const reverseAgencyChargeFn = createServerFn({ method: 'POST' })
  .validator(reversalSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('reverse_agency_charge', {
      p_actor: actor.id,
      p_id: data.id,
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

export const reverseAgencyPaymentFn = createServerFn({ method: 'POST' })
  .validator(reversalSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('reverse_agency_payment', {
      p_actor: actor.id,
      p_id: data.id,
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

// ----------------------------------------------------------------- periods ---

export interface FinancePeriodRow {
  /** YYYY-MM-01 */
  month: string
  status: 'OPEN' | 'CLOSED'
  closed_at: string | null
  reopened_at: string | null
  reopen_reason: string | null
}

/** The last twelve months (Asia/Dhaka), newest first, with their state. */
export const listFinancePeriodsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<FinancePeriodRow>> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient().from('finance_periods').select('*')
    if (error) throw new Error(error.message)
    const byMonth = new Map((data ?? []).map((r) => [r.month as string, r]))
    const [y, m] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }).split('-').map(Number)
    const months: Array<FinancePeriodRow> = []
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1))
      const key = d.toISOString().slice(0, 10)
      const r = byMonth.get(key)
      months.push({
        month: key,
        status: (r?.status as 'OPEN' | 'CLOSED' | undefined) ?? 'OPEN',
        closed_at: (r?.closed_at as string | null) ?? null,
        reopened_at: (r?.reopened_at as string | null) ?? null,
        reopen_reason: (r?.reopen_reason as string | null) ?? null,
      })
    }
    return months
  },
)

export const closeFinancePeriodFn = createServerFn({ method: 'POST' })
  .validator(z.object({ month: z.iso.date() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('close_finance_period', {
      p_actor: actor.id,
      p_month: data.month,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

export const reopenFinancePeriodFn = createServerFn({ method: 'POST' })
  .validator(z.object({ month: z.iso.date(), reason }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('reopen_finance_period', {
      p_actor: actor.id,
      p_month: data.month,
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

// ------------------------------------------------- payments from agencies ---
// Agencies submit what they paid, with proof (migration 000066); a platform
// admin approves it into agency_payments or rejects it with a reason.

const PROOF_ENTITY_AGENCY_PAYMENT = 'AGENCY_PAYMENT_SUBMISSION'
const INSTRUCTIONS_KEY = 'agency_payment_instructions'

export interface AgencyPaymentSubmissionRow {
  id: string
  reference_id: string
  organization_id: string
  agency_name: string
  bdt_amount: string
  method: string
  external_reference: string | null
  paid_at: string
  note: string | null
  submitted_at: string
  has_proof: boolean
  /** What the agency owes right now (before this payment). */
  owed_bdt: string
}

export const listPendingAgencyPaymentsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<AgencyPaymentSubmissionRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('agency_payment_submissions')
      .select('id, reference_id, organization_id, bdt_amount, method, external_reference, paid_at, note, submitted_at, organization:organizations(name)')
      .eq('status', 'PENDING')
      .order('submitted_at')
      .limit(200)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as unknown as Array<Record<string, unknown> & { organization: { name: string } | null }>
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id as string)
    const orgs = [...new Set(rows.map((r) => r.organization_id as string))]
    const [proofs, owed] = await Promise.all([
      admin.from('attachments').select('entity_id').eq('entity_type', PROOF_ENTITY_AGENCY_PAYMENT).in('entity_id', ids),
      admin.from('agency_billing_summary').select('organization_id, owed_bdt').in('organization_id', orgs),
    ])
    const withProof = new Set((proofs.data ?? []).map((a) => a.entity_id as string))
    const owedBy = new Map((owed.data ?? []).map((o) => [o.organization_id as string, bdt(o.owed_bdt)]))
    return rows.map((r) => ({
      id: r.id as string,
      reference_id: r.reference_id as string,
      organization_id: r.organization_id as string,
      agency_name: r.organization?.name ?? 'Agency',
      bdt_amount: bdt(r.bdt_amount),
      method: r.method as string,
      external_reference: (r.external_reference as string | null) ?? null,
      paid_at: r.paid_at as string,
      note: (r.note as string | null) ?? null,
      submitted_at: r.submitted_at as string,
      has_proof: withProof.has(r.id as string),
      owed_bdt: owedBy.get(r.organization_id as string) ?? '0.00',
    }))
  },
)

export const getAgencyPaymentProofUrlFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<string> => {
    await requirePlatformAdmin()
    const { data: att } = await getSupabaseAdminClient()
      .from('attachments')
      .select('storage_path')
      .eq('entity_type', PROOF_ENTITY_AGENCY_PAYMENT)
      .eq('entity_id', data.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!att) throw new UserError('No proof was attached to that payment')
    return signProofUrl(att.storage_path as string)
  })

export const approveAgencyPaymentSubmissionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), bdt_amount: z.coerce.number().positive().max(1_000_000_000_000).optional() }))
  .handler(async ({ data }): Promise<{ applied_bdt: string; advance_bdt: string }> => {
    const actor = await requirePlatformAdmin()
    const { data: r, error } = await getSupabaseAdminClient().rpc('approve_agency_payment_submission', {
      p_actor: actor.id,
      p_id: data.id,
      p_bdt: data.bdt_amount == null ? null : dec(data.bdt_amount).toDecimalPlaces(2).toNumber(),
    })
    if (error) throw inventoryRpcError(error.message)
    const row = r as Record<string, unknown>
    const amount = bdt(row.approved_bdt ?? row.bdt_amount)
    await notifySuperAdmins({
      organizationId: row.organization_id as string,
      type: 'AGENCY_PAYMENT_APPROVED',
      title: 'Payment to the platform approved',
      message: `${row.reference_id as string}: ${formatBdt(amount)} was accepted${dec(bdt(row.advance_bdt)).gt(0) ? `; ${formatBdt(bdt(row.advance_bdt))} is kept as credit for your next approvals` : ''}.`,
      entityType: 'AGENCY_PAYMENT_SUBMISSION',
      entityId: data.id,
    })
    return { applied_bdt: bdt(row.applied_bdt), advance_bdt: bdt(row.advance_bdt) }
  })

export const rejectAgencyPaymentSubmissionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), reason }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { data: r, error } = await getSupabaseAdminClient().rpc('reject_agency_payment_submission', {
      p_actor: actor.id,
      p_id: data.id,
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    const row = r as Record<string, unknown>
    await notifySuperAdmins({
      organizationId: row.organization_id as string,
      type: 'AGENCY_PAYMENT_REJECTED',
      title: 'Payment to the platform not accepted',
      message: `${row.reference_id as string} (${formatBdt(bdt(row.bdt_amount))}) was not accepted: ${data.reason}`,
      entityType: 'AGENCY_PAYMENT_SUBMISSION',
      entityId: data.id,
    })
    return { ok: true }
  })

/** Where agencies should send money — shown on their Platform Billing page. */
export const getAgencyPaymentInstructionsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<string> => {
    await requirePlatformAdmin()
    const { data } = await getSupabaseAdminClient().from('platform_settings').select('value').eq('key', INSTRUCTIONS_KEY).maybeSingle()
    return (data?.value as string | null) ?? ''
  },
)

export const setAgencyPaymentInstructionsFn = createServerFn({ method: 'POST' })
  .validator(z.object({ value: z.string().trim().max(2000) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient()
      .from('platform_settings')
      .upsert({ key: INSTRUCTIONS_KEY, value: data.value || null, updated_by: actor.id })
    if (error) throw new Error(error.message)
    return { ok: true }
  })
