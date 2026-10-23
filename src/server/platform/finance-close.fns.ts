import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { dec } from '@/lib/money/money'
import { inventoryRpcError } from '@/server/platform/usd-inventory.service'
import { organizationId } from '@/schemas/organization'
import { buildAgencyStatement } from '@/server/platform/agency-statement.service'
import type { AgencyStatementRow } from '@/server/platform/agency-statement.service'

/**
 * Finance v2 Milestone 5 (migration 000065): the overview, the profit report,
 * reconciliation against real wallet and bank balances, the opening bank
 * balance, returning or writing off unspent prepaid credit, suppliers on FIFO,
 * and the client-safe agency statement. Platform admins only.
 */

const money = (v: unknown): string => (v == null ? '0.00' : dec(v as string | number).toFixed(2))
const reason = z.string().trim().min(1, 'Give a reason').max(500)
const isoDateTime = z.iso.datetime({ offset: true, message: 'Enter a valid date and time' })

const dhakaMonthStart = (d = new Date()): Date => {
  const [y, m] = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }).split('-').map(Number)
  return new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00+06:00`)
}

// ------------------------------------------------------------ profit report ---

export interface ProfitReport {
  from: string
  to: string
  revenue_bdt: string
  meta_cost_bdt: string
  meta_cost_usd: string
  write_off_bdt: string
  other_bdt: string
  gross_profit_bdt: string
  net_after_other_bdt: string
  /** BDT per USD of what is in stock now; null with nothing in stock. */
  avg_stock_cost: string | null
  /** Meta's average cost per dollar in the period (cost ÷ USD), or null. */
  period_cost_per_usd: string | null
  unpaid_meta_usd: string
  billed_unspent_usd: string
  agencies: Array<{
    organization_id: string | null
    name: string
    revenue_bdt: string
    billed_usd: string
    spend_usd: string
    /** spend × the period's Meta cost per dollar (or stock cost). Estimate. */
    est_cost_bdt: string | null
    est_margin_bdt: string | null
  }>
}

async function profitReport(from: string, to: string): Promise<ProfitReport> {
  const { data, error } = await getSupabaseAdminClient().rpc('finance_profit_report', { p_from: from, p_to: to })
  if (error) throw new Error(error.message)
  const r = data as Record<string, unknown> & { agencies: Array<Record<string, unknown>> }
  const costUsd = dec(money(r.meta_cost_usd))
  const perUsd = costUsd.gt(0)
    ? dec(money(r.meta_cost_bdt)).div(costUsd)
    : r.avg_stock_cost == null
      ? null
      : dec(r.avg_stock_cost as number)
  return {
    from,
    to,
    revenue_bdt: money(r.revenue_bdt),
    meta_cost_bdt: money(r.meta_cost_bdt),
    meta_cost_usd: money(r.meta_cost_usd),
    write_off_bdt: money(r.write_off_bdt),
    other_bdt: money(r.other_bdt),
    gross_profit_bdt: money(r.gross_profit_bdt),
    net_after_other_bdt: money(r.net_after_other_bdt),
    avg_stock_cost: r.avg_stock_cost == null ? null : dec(r.avg_stock_cost as number).toFixed(4),
    period_cost_per_usd: perUsd ? perUsd.toFixed(4) : null,
    unpaid_meta_usd: money(r.unpaid_meta_usd),
    billed_unspent_usd: money(r.billed_unspent_usd),
    agencies: (r.agencies ?? []).map((a) => {
      const est = perUsd ? dec(money(a.spend_usd)).mul(perUsd) : null
      return {
        organization_id: (a.organization_id as string | null) ?? null,
        name: a.name as string,
        revenue_bdt: money(a.revenue_bdt),
        billed_usd: money(a.billed_usd),
        spend_usd: money(a.spend_usd),
        est_cost_bdt: est ? est.toFixed(2) : null,
        est_margin_bdt: est ? dec(money(a.revenue_bdt)).minus(est).toFixed(2) : null,
      }
    }),
  }
}

export const getProfitReportFn = createServerFn({ method: 'GET' })
  .validator(z.object({ from: isoDateTime, to: isoDateTime }))
  .handler(async ({ data }): Promise<ProfitReport> => {
    await requirePlatformAdmin()
    if (data.to <= data.from) throw new Error('The end must be after the start')
    return profitReport(data.from, data.to)
  })

// ----------------------------------------------------------------- overview ---

export interface FinanceOverview {
  stock_usd: string
  stock_bdt: string
  agencies_owed_bdt: string
  agencies_advance_bdt: string
  owed_to_meta_usd: string
  month: ProfitReport
  books_tie: boolean
  checklist: {
    opening_stock_set: boolean
    opening_bank_set: boolean
    agencies_without_rate: Array<string>
    suppliers_without_bank: Array<string>
    pending_rate_charges: number
    open_meta_exceptions: number
    open_reconciliation_differences: number
    agency_payments_to_review: number
  }
  last_reconciliation: Partial<Record<'USD_WALLETS' | 'BANK', { at: string; status: string; difference: string }>>
}

export const getFinanceOverviewFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<FinanceOverview> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const monthStart = dhakaMonthStart()
    const [fifo, agencies, meta, tb, opening, openingBank, sources, exceptions, recons, month, lots, toReview] = await Promise.all([
      admin.from('usd_fifo_summary').select('left_usd, left_bdt').single(),
      admin.from('agency_billing_summary').select('name, current_rate, owed_bdt, advance_bdt, pending_rate, organization_id'),
      admin.from('meta_account_positions').select('owed_usd'),
      admin.rpc('gl_trial_balance', { p_as_of: 'infinity' }),
      admin.from('usd_outflows').select('id', { count: 'exact', head: true }).eq('kind', 'OPENING_ADJUSTMENT').eq('status', 'POSTED'),
      admin.from('finance_openings').select('id', { count: 'exact', head: true }).eq('kind', 'BANK').eq('status', 'POSTED'),
      admin.from('usd_sources').select('name, receiving_institution').eq('is_active', true),
      admin.from('meta_spend_exceptions').select('id', { count: 'exact', head: true }).is('resolved_at', null),
      admin.from('reconciliation_records').select('scope, created_at, status, difference').order('created_at', { ascending: false }).limit(50),
      profitReport(monthStart.toISOString(), new Date(Date.now() + 60_000).toISOString()),
      admin.from('meta_prepaid_lot_balances').select('left_bdt').eq('status', 'POSTED'),
      admin.from('agency_payment_submissions').select('id', { count: 'exact', head: true }).eq('status', 'PENDING'),
    ])
    for (const r of [fifo, agencies, meta, tb, opening, openingBank, sources, exceptions, recons, lots, toReview]) {
      if (r.error) throw new Error(r.error.message)
    }
    const f = fifo.data as { left_usd: number; left_bdt: number }
    const ag = (agencies.data ?? []) as Array<{ name: string; current_rate: number | null; owed_bdt: number; advance_bdt: number; pending_rate: number }>
    const rows = (tb.data ?? []) as Array<{ code: string; balance_bdt: number }>
    const bal = (c: string) => dec(rows.find((r) => r.code === c)?.balance_bdt ?? 0)
    const lotsBdt = (lots.data ?? []).reduce((s, l) => s.plus(l.left_bdt as number), dec(0))
    const recRows = (recons.data ?? []) as Array<{ scope: 'USD_WALLETS' | 'BANK'; created_at: string; status: string; difference: number }>
    const last: FinanceOverview['last_reconciliation'] = {}
    for (const r of recRows) {
      if (!last[r.scope]) last[r.scope] = { at: r.created_at, status: r.status, difference: money(r.difference) }
    }
    const hasStock = dec(f.left_usd).gt(0)

    return {
      stock_usd: money(f.left_usd),
      stock_bdt: money(f.left_bdt),
      agencies_owed_bdt: ag.reduce((s, a) => s.plus(a.owed_bdt), dec(0)).toFixed(2),
      agencies_advance_bdt: ag.reduce((s, a) => s.plus(a.advance_bdt), dec(0)).toFixed(2),
      owed_to_meta_usd: ((meta.data ?? []) as Array<{ owed_usd: number }>)
        .reduce((s, m) => (dec(m.owed_usd).gt(0) ? s.plus(m.owed_usd) : s), dec(0))
        .toFixed(2),
      month,
      books_tie: bal('1200').eq(dec(f.left_bdt)) && bal('1400').eq(lotsBdt),
      checklist: {
        // Nothing in stock means nothing to cut over.
        opening_stock_set: (opening.count ?? 0) > 0 || !hasStock,
        opening_bank_set: (openingBank.count ?? 0) > 0,
        agencies_without_rate: ag.filter((a) => a.current_rate == null).map((a) => a.name),
        suppliers_without_bank: ((sources.data ?? []) as Array<{ name: string; receiving_institution: string | null }>)
          .filter((s) => !s.receiving_institution)
          .map((s) => s.name),
        pending_rate_charges: ag.reduce((s, a) => s + Number(a.pending_rate), 0),
        open_meta_exceptions: exceptions.count ?? 0,
        open_reconciliation_differences: recRows.filter((r) => r.status === 'DIFFERENCE').length,
        agency_payments_to_review: toReview.count ?? 0,
      },
      last_reconciliation: last,
    }
  },
)

// ------------------------------------------------------------- reconcile ---

export interface ReconciliationRow {
  id: string
  scope: 'USD_WALLETS' | 'BANK'
  currency: 'USD' | 'BDT'
  as_of: string
  expected: string
  actual: string
  difference: string
  details: Array<{ wallet: string; usd: number }>
  note: string | null
  status: 'MATCHED' | 'DIFFERENCE' | 'RESOLVED'
  resolution_note: string | null
}

export const listReconciliationsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<ReconciliationRow>> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient()
      .from('reconciliation_records')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => ({
      id: r.id as string,
      scope: r.scope as ReconciliationRow['scope'],
      currency: r.currency as ReconciliationRow['currency'],
      as_of: r.as_of as string,
      expected: money(r.expected),
      actual: money(r.actual),
      difference: money(r.difference),
      details: (r.details ?? []) as ReconciliationRow['details'],
      note: (r.note as string | null) ?? null,
      status: r.status as ReconciliationRow['status'],
      resolution_note: (r.resolution_note as string | null) ?? null,
    }))
  },
)

export const recordReconciliationFn = createServerFn({ method: 'POST' })
  .validator(
    z.discriminatedUnion('scope', [
      z.object({
        scope: z.literal('USD_WALLETS'),
        wallets: z
          .array(z.object({ wallet: z.string().trim().min(1).max(60), usd: z.coerce.number().min(0) }))
          .min(1, 'Add at least one wallet'),
        note: z.string().trim().max(500).optional(),
      }),
      z.object({
        scope: z.literal('BANK'),
        bdt: z.coerce.number(),
        as_of: isoDateTime,
        note: z.string().trim().max(500).optional(),
      }),
    ]),
  )
  .handler(async ({ data }): Promise<ReconciliationRow['status']> => {
    const actor = await requirePlatformAdmin()
    const actual =
      data.scope === 'USD_WALLETS'
        ? data.wallets.reduce((s, w) => s.plus(w.usd), dec(0)).toDecimalPlaces(2).toNumber()
        : dec(data.bdt).toDecimalPlaces(2).toNumber()
    const { data: row, error } = await getSupabaseAdminClient().rpc('record_reconciliation', {
      p_actor: actor.id,
      p_scope: data.scope,
      p_as_of: data.scope === 'BANK' ? data.as_of : new Date().toISOString(),
      p_actual: actual,
      p_details: data.scope === 'USD_WALLETS' ? data.wallets : [],
      p_note: data.note ?? null,
    })
    if (error) throw inventoryRpcError(error.message)
    return (row as { status: ReconciliationRow['status'] }).status
  })

export const resolveReconciliationFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid(), note: reason }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('resolve_reconciliation', {
      p_actor: actor.id,
      p_id: data.id,
      p_note: data.note,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

export interface OpeningBank {
  bdt_amount: string
  as_of: string
  notes: string
}

export const getOpeningBankFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<OpeningBank | null> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient()
      .from('finance_openings')
      .select('bdt_amount, as_of, notes')
      .eq('kind', 'BANK')
      .eq('status', 'POSTED')
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data ? { bdt_amount: money(data.bdt_amount), as_of: data.as_of as string, notes: data.notes as string } : null
  },
)

export const recordOpeningBankFn = createServerFn({ method: 'POST' })
  .validator(z.object({ bdt: z.coerce.number().refine((v) => v !== 0, 'Enter a non-zero amount'), as_of: isoDateTime, notes: reason }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('record_opening_bank', {
      p_actor: actor.id,
      p_bdt: dec(data.bdt).toDecimalPlaces(2).toNumber(),
      p_as_of: data.as_of,
      p_notes: data.notes,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

export const reverseOpeningBankFn = createServerFn({ method: 'POST' })
  .validator(z.object({ reason }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('reverse_opening_bank', { p_actor: actor.id, p_reason: data.reason })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

// -------------------------------------------------------- prepaid credit ---

export const adjustPrepaidCreditFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      ad_account_id: z.uuid(),
      kind: z.enum(['RETURN', 'WRITE_OFF']),
      usd: z.coerce.number().positive('Enter an amount above zero'),
      reason,
    }),
  )
  .handler(async ({ data }): Promise<{ reference_id: string; bdt: string }> => {
    const actor = await requirePlatformAdmin()
    const { data: r, error } = await getSupabaseAdminClient().rpc('adjust_prepaid_credit', {
      p_actor: actor.id,
      p_account: data.ad_account_id,
      p_kind: data.kind,
      p_usd: dec(data.usd).toDecimalPlaces(2).toNumber(),
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    const row = r as { reference_id: string; bdt: number }
    return { reference_id: row.reference_id, bdt: money(row.bdt) }
  })

export interface PrepaidAdjustmentRow {
  group_id: string
  reference_id: string
  kind: 'RETURN' | 'WRITE_OFF'
  ad_account: { account_code: string; name: string } | null
  usd: string
  bdt: string
  event_at: string
  reason: string
  status: 'POSTED' | 'REVERSED'
}

/** One row per action (an action spanning several lots is summed). */
export const listPrepaidAdjustmentsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<PrepaidAdjustmentRow>> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient()
      .from('meta_prepaid_adjustments')
      .select('group_id, reference_id, kind, usd, bdt, event_at, reason, status, ad_account:ad_accounts(account_code, name)')
      .order('event_at', { ascending: false })
      .limit(300)
    if (error) throw new Error(error.message)
    const groups = new Map<string, PrepaidAdjustmentRow>()
    for (const raw of data ?? []) {
      const r = raw as unknown as Record<string, unknown> & { ad_account: PrepaidAdjustmentRow['ad_account'] }
      const g = groups.get(r.group_id as string)
      if (g) {
        g.usd = dec(g.usd).plus(r.usd as number).toFixed(2)
        g.bdt = dec(g.bdt).plus(r.bdt as number).toFixed(2)
      } else {
        groups.set(r.group_id as string, {
          group_id: r.group_id as string,
          reference_id: r.reference_id as string,
          kind: r.kind as PrepaidAdjustmentRow['kind'],
          ad_account: r.ad_account,
          usd: money(r.usd),
          bdt: money(r.bdt),
          event_at: r.event_at as string,
          reason: r.reason as string,
          status: r.status as PrepaidAdjustmentRow['status'],
        })
      }
    }
    return [...groups.values()]
  },
)

export const reversePrepaidAdjustmentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ group_id: z.uuid(), reason }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('reverse_prepaid_adjustment', {
      p_actor: actor.id,
      p_group: data.group_id,
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

// ---------------------------------------------------------------- suppliers ---

export interface SupplierStockRow {
  source_id: string
  name: string
  payment_method: string | null
  receiving_institution: string | null
  is_active: boolean
  batches: number
  net_usd: string
  cost_bdt: string
  /** cost ÷ net USD over this supplier's posted batches; null with none. */
  avg_effective_rate: string | null
  left_usd: string
  left_bdt: string
}

/** Per supplier, from the FIFO batches: bought, cost, and what is still in stock. */
export const listSupplierStockFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<SupplierStockRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const [sources, balances] = await Promise.all([
      admin.from('usd_sources').select('id, name, payment_method, receiving_institution, is_active'),
      admin.from('usd_batch_balances').select('source_id, net_usd, total_bdt_cost, left_usd, left_bdt').eq('status', 'POSTED'),
    ])
    if (sources.error) throw new Error(sources.error.message)
    if (balances.error) throw new Error(balances.error.message)
    const agg = new Map<string, { n: number; net: ReturnType<typeof dec>; cost: ReturnType<typeof dec>; lu: ReturnType<typeof dec>; lb: ReturnType<typeof dec> }>()
    for (const b of balances.data ?? []) {
      if (!b.source_id) continue // a prepaid return has no supplier
      const a = agg.get(b.source_id) ?? { n: 0, net: dec(0), cost: dec(0), lu: dec(0), lb: dec(0) }
      a.n += 1
      a.net = a.net.plus(b.net_usd)
      a.cost = a.cost.plus(b.total_bdt_cost)
      a.lu = a.lu.plus(b.left_usd)
      a.lb = a.lb.plus(b.left_bdt)
      agg.set(b.source_id, a)
    }
    return (sources.data ?? [])
      .map((s) => {
        const a = agg.get(s.id as string)
        return {
          source_id: s.id as string,
          name: s.name as string,
          payment_method: (s.payment_method as string | null) ?? null,
          receiving_institution: (s.receiving_institution as string | null) ?? null,
          is_active: s.is_active as boolean,
          batches: a?.n ?? 0,
          net_usd: (a?.net ?? dec(0)).toFixed(2),
          cost_bdt: (a?.cost ?? dec(0)).toFixed(2),
          avg_effective_rate: a && a.net.gt(0) ? a.cost.div(a.net).toFixed(4) : null,
          left_usd: (a?.lu ?? dec(0)).toFixed(2),
          left_bdt: (a?.lb ?? dec(0)).toFixed(2),
        }
      })
      .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }))
  },
)

// ------------------------------------------------------- agency statement ---

/** Client-safe statement of one agency (see agency-statement.service.ts). */
export const getAgencyStatementFn = createServerFn({ method: 'GET' })
  .validator(z.object({ organization_id: organizationId }))
  .handler(async ({ data }): Promise<{ agency: string; rows: Array<AgencyStatementRow> }> => {
    await requirePlatformAdmin()
    return buildAgencyStatement(getSupabaseAdminClient(), data.organization_id)
  })
