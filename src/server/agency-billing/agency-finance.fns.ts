import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireSuperAdmin } from '@/server/auth/guards.server'
import { dec } from '@/lib/money/money'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * /agency/finance — the agency's own money picture for limits on the
 * PLATFORM's pool accounts (owner decisions, 2026-10-23):
 *
 *   billed to clients (their rate) − owed to the platform (the agency's rate)
 *     = the agency's margin, per approval;
 *   collected from clients vs paid to the platform = the cash the agency
 *     still holds for the platform.
 *
 * The agency owes the platform when the limit is approved (000064), whether or
 * not the client has paid yet. Everything here is computed from approvals,
 * the client ledger and platform charges/payments — nothing is typed in.
 * SUPER_ADMIN only, always the caller's own organization. Shows the agency's
 * own rates only — never the platform's cost.
 */

const money = (v: unknown): string => (v == null ? '0.00' : dec(v as string | number).toFixed(2))
const range = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
})

export type MarginRowStatus =
  | 'PRICED'
  /** The platform hasn't set this agency's rate yet. */
  | 'WAITING_RATE'
  /** Approved before platform billing started (21 Oct 2026). */
  | 'BEFORE_BILLING'
  /** The platform reversed its charge. */
  | 'PLATFORM_REVERSED'

export interface MarginRow {
  limit_request_id: string
  request_number: string
  approved_at: string
  client: string
  ad_account: { account_code: string; name: string } | null
  usd: string
  client_rate: string | null
  client_bdt: string
  /** The agency reversed this charge in the client's ledger. */
  client_reversed: boolean
  platform_rate: string | null
  platform_bdt: string | null
  margin_bdt: string | null
  status: MarginRowStatus
}

async function marginRows(admin: SupabaseClient, org: string, from: string, to: string): Promise<Array<MarginRow>> {
  const { data: lrs, error } = await admin
    .from('limit_requests')
    .select('id, request_number, approved_at, approved_amount_usd, approved_usd_rate, bdt_charge, client:clients(name), ad_account:ad_accounts!inner(account_code, name, is_platform)')
    .eq('organization_id', org)
    .eq('status', 'APPROVED')
    .eq('ad_account.is_platform', true)
    .gte('approved_at', from)
    .lt('approved_at', to)
    .order('approved_at', { ascending: false })
    .limit(2000)
  if (error) throw new Error(error.message)
  const rows = (lrs ?? []) as unknown as Array<{
    id: string
    request_number: string
    approved_at: string
    approved_amount_usd: number | null
    approved_usd_rate: number | null
    bdt_charge: number | null
    client: { name: string } | null
    ad_account: { account_code: string; name: string } | null
  }>
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)

  const [charges, ledger] = await Promise.all([
    admin.from('agency_charges').select('limit_request_id, rate, bdt_amount, status').eq('organization_id', org).in('limit_request_id', ids),
    admin.from('ledger_entries').select('id, reference_id').eq('organization_id', org).eq('type', 'LIMIT_APPROVAL').in('reference_id', ids),
  ])
  if (charges.error) throw new Error(charges.error.message)
  if (ledger.error) throw new Error(ledger.error.message)
  const chargeBy = new Map((charges.data ?? []).map((c) => [c.limit_request_id as string, c]))
  const ledgerIdBy = new Map((ledger.data ?? []).map((l) => [l.reference_id as string, l.id as string]))
  const ledgerIds = [...ledgerIdBy.values()]
  const reversedLedger = new Set<string>()
  if (ledgerIds.length) {
    const { data: rev, error: revErr } = await admin
      .from('ledger_entries')
      .select('reference_id')
      .eq('organization_id', org)
      .eq('type', 'REVERSAL')
      .in('reference_id', ledgerIds)
    if (revErr) throw new Error(revErr.message)
    for (const r of rev ?? []) reversedLedger.add(r.reference_id as string)
  }

  return rows.map((r) => {
    const c = chargeBy.get(r.id)
    const clientReversed = reversedLedger.has(ledgerIdBy.get(r.id) ?? '')
    const clientBdt = clientReversed ? dec(0) : dec(r.bdt_charge ?? 0)
    let status: MarginRowStatus
    let platformBdt: ReturnType<typeof dec> | null = null
    if (!c) status = 'BEFORE_BILLING'
    else if (c.status === 'PENDING_RATE') status = 'WAITING_RATE'
    else if (c.status === 'REVERSED') {
      status = 'PLATFORM_REVERSED'
      platformBdt = dec(0)
    } else {
      status = 'PRICED'
      platformBdt = dec(c.bdt_amount as number)
    }
    return {
      limit_request_id: r.id,
      request_number: r.request_number,
      approved_at: r.approved_at,
      client: r.client?.name ?? '—',
      ad_account: r.ad_account ? { account_code: r.ad_account.account_code, name: r.ad_account.name } : null,
      usd: money(r.approved_amount_usd),
      client_rate: r.approved_usd_rate == null ? null : dec(r.approved_usd_rate).toFixed(2),
      client_bdt: clientBdt.toFixed(2),
      client_reversed: clientReversed,
      platform_rate: c?.rate == null ? null : dec(c.rate as number).toFixed(2),
      platform_bdt: platformBdt ? platformBdt.toFixed(2) : null,
      margin_bdt: platformBdt ? clientBdt.minus(platformBdt).toFixed(2) : null,
      status,
    }
  })
}

export const listAgencyMarginFn = createServerFn({ method: 'GET' })
  .validator(range)
  .handler(async ({ data }): Promise<Array<MarginRow>> => {
    const user = await requireSuperAdmin()
    return marginRows(getSupabaseAdminClient(), user.organizationId, data.from, data.to)
  })

export interface AgencyFinanceSummary {
  /** Pool-account approvals in the period. */
  approvals: number
  usd: string
  billed_to_clients_bdt: string
  /** Only approvals the platform has priced (status PRICED). */
  priced: number
  priced_usd: string
  priced_client_bdt: string
  owed_to_platform_bdt: string
  margin_bdt: string
  /** Average BDT per USD over the priced approvals. */
  avg_client_rate: string | null
  avg_platform_rate: string | null
  waiting_rate: number
  before_billing: number
  /** Cash in the period. */
  collected_from_clients_bdt: string
  paid_to_platform_bdt: string
  /** Now, not the period: what the agency still owes the platform / its credit. */
  owed_to_platform_now_bdt: string
  credit_with_platform_bdt: string
}

export const getAgencyFinanceSummaryFn = createServerFn({ method: 'GET' })
  .validator(range)
  .handler(async ({ data }): Promise<AgencyFinanceSummary> => {
    const user = await requireSuperAdmin()
    const admin = getSupabaseAdminClient()
    const org = user.organizationId

    const [rows, payments, reversals, paid, balance] = await Promise.all([
      marginRows(admin, org, data.from, data.to),
      admin.from('ledger_entries').select('id, credit_bdt').eq('organization_id', org).eq('type', 'PAYMENT').gte('created_at', data.from).lt('created_at', data.to),
      admin.from('ledger_entries').select('reference_id, debit_bdt').eq('organization_id', org).eq('type', 'REVERSAL').gte('created_at', data.from).lt('created_at', data.to),
      admin.from('agency_payments').select('bdt_amount').eq('organization_id', org).eq('status', 'POSTED').gte('received_at', data.from).lt('received_at', data.to),
      admin.rpc('agency_balance', { p_org: org }),
    ])
    for (const r of [payments, reversals, paid, balance]) if (r.error) throw new Error(r.error.message)

    // A reversed client payment no longer counts as collected.
    let reversedPayments = dec(0)
    const revRows = (reversals.data ?? []) as Array<{ reference_id: string; debit_bdt: number }>
    if (revRows.length) {
      const { data: orig } = await admin
        .from('ledger_entries')
        .select('id')
        .eq('organization_id', org)
        .eq('type', 'PAYMENT')
        .in('id', revRows.map((r) => r.reference_id))
      const paymentIds = new Set((orig ?? []).map((o) => o.id as string))
      for (const r of revRows) if (paymentIds.has(r.reference_id)) reversedPayments = reversedPayments.plus(r.debit_bdt)
    }

    const sum = (xs: Array<string | null>) => xs.reduce((t, x) => (x == null ? t : t.plus(x)), dec(0))
    const priced = rows.filter((r) => r.status === 'PRICED')
    const pricedUsd = sum(priced.map((r) => r.usd))
    const pricedClient = sum(priced.map((r) => r.client_bdt))
    const owed = sum(priced.map((r) => r.platform_bdt))
    const b = balance.data as { owed_bdt: number; advance_bdt: number }

    return {
      approvals: rows.length,
      usd: sum(rows.map((r) => r.usd)).toFixed(2),
      billed_to_clients_bdt: sum(rows.map((r) => r.client_bdt)).toFixed(2),
      priced: priced.length,
      priced_usd: pricedUsd.toFixed(2),
      priced_client_bdt: pricedClient.toFixed(2),
      owed_to_platform_bdt: owed.toFixed(2),
      margin_bdt: pricedClient.minus(owed).toFixed(2),
      avg_client_rate: pricedUsd.gt(0) ? pricedClient.div(pricedUsd).toFixed(2) : null,
      avg_platform_rate: pricedUsd.gt(0) ? owed.div(pricedUsd).toFixed(2) : null,
      waiting_rate: rows.filter((r) => r.status === 'WAITING_RATE').length,
      before_billing: rows.filter((r) => r.status === 'BEFORE_BILLING').length,
      collected_from_clients_bdt: sum((payments.data ?? []).map((p) => money(p.credit_bdt))).minus(reversedPayments).toFixed(2),
      paid_to_platform_bdt: sum((paid.data ?? []).map((p) => money(p.bdt_amount))).toFixed(2),
      owed_to_platform_now_bdt: money(b.owed_bdt),
      credit_with_platform_bdt: money(b.advance_bdt),
    }
  })
