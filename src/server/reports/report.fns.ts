import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { dec } from '@/lib/money/money'
import { PERMISSIONS } from '@/lib/permissions/permissions'

// ---------------------------------------------------------------------------
// Shared filters (spec §71). Dates are inclusive calendar days.
// ---------------------------------------------------------------------------
const reportFilterSchema = z.object({
  from: z.string().optional(), // YYYY-MM-DD
  to: z.string().optional(), // YYYY-MM-DD
  client_id: z.uuid().optional(),
})
type ReportFilter = z.infer<typeof reportFilterSchema>

function endOfDay(date: string): string {
  return `${date}T23:59:59.999`
}
function startOfDay(date: string): string {
  return `${date}T00:00:00`
}

// ---------------------------------------------------------------------------
// Client Due Report (spec §71) — every client, billed / paid / due.
// ---------------------------------------------------------------------------
export interface ClientDueRow {
  client_id: string
  client_code: string
  name: string
  status: string
  total_billed: string
  total_paid: string
  current_due: string
}

export const clientDueReportFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<ClientDueRow>> => {
    await requireAdmin(PERMISSIONS.REPORTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin.rpc('all_client_dues')
    if (error) throw new Error(error.message)
    return ((data ?? []) as Array<ClientDueRow>).map((r) => ({
      ...r,
      total_billed: String(r.total_billed),
      total_paid: String(r.total_paid),
      current_due: String(r.current_due),
    }))
  },
)

// ---------------------------------------------------------------------------
// Limit Approval Report (spec §71).
// ---------------------------------------------------------------------------
export interface LimitApprovalRow {
  id: string
  request_number: string
  client_name: string | null
  account_name: string | null
  approved_amount_usd: string | null
  approved_usd_rate: string | null
  bdt_charge: string | null
  approved_new_limit_usd: string | null
  reviewed_at: string | null
}

export const limitApprovalReportFn = createServerFn({ method: 'GET' })
  .validator(reportFilterSchema)
  .handler(async ({ data }: { data: ReportFilter }): Promise<
    Array<LimitApprovalRow>
  > => {
    await requireAdmin(PERMISSIONS.REPORTS_VIEW)
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('limit_requests')
      .select(
        'id, request_number, approved_amount_usd, approved_usd_rate, bdt_charge, approved_new_limit_usd, reviewed_at, client:clients(name), ad_account:ad_accounts(name)',
      )
      .eq('status', 'APPROVED')
      .order('reviewed_at', { ascending: false })
      .limit(1000)
    if (data.client_id) query = query.eq('client_id', data.client_id)
    if (data.from) query = query.gte('reviewed_at', startOfDay(data.from))
    if (data.to) query = query.lte('reviewed_at', endOfDay(data.to))
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      request_number: r.request_number as string,
      client_name: (r.client as { name: string } | null)?.name ?? null,
      account_name: (r.ad_account as { name: string } | null)?.name ?? null,
      approved_amount_usd: (r.approved_amount_usd as string | null) ?? null,
      approved_usd_rate: (r.approved_usd_rate as string | null) ?? null,
      bdt_charge: (r.bdt_charge as string | null) ?? null,
      approved_new_limit_usd:
        (r.approved_new_limit_usd as string | null) ?? null,
      reviewed_at: (r.reviewed_at as string | null) ?? null,
    }))
  })

// ---------------------------------------------------------------------------
// Payment Collection Report (spec §71).
// ---------------------------------------------------------------------------
export interface PaymentCollectionRow {
  id: string
  payment_number: string
  client_name: string | null
  amount_bdt: string
  payment_method: string | null
  transaction_reference: string | null
  reviewed_at: string | null
}

export const paymentCollectionReportFn = createServerFn({ method: 'GET' })
  .validator(reportFilterSchema)
  .handler(async ({ data }: { data: ReportFilter }): Promise<
    Array<PaymentCollectionRow>
  > => {
    await requireAdmin(PERMISSIONS.REPORTS_VIEW)
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('payments')
      .select(
        'id, payment_number, amount_bdt, payment_method, transaction_reference, reviewed_at, client:clients(name)',
      )
      .eq('status', 'APPROVED')
      .order('reviewed_at', { ascending: false })
      .limit(1000)
    if (data.client_id) query = query.eq('client_id', data.client_id)
    if (data.from) query = query.gte('reviewed_at', startOfDay(data.from))
    if (data.to) query = query.lte('reviewed_at', endOfDay(data.to))
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      payment_number: r.payment_number as string,
      client_name: (r.client as { name: string } | null)?.name ?? null,
      amount_bdt: r.amount_bdt as string,
      payment_method: (r.payment_method as string | null) ?? null,
      transaction_reference:
        (r.transaction_reference as string | null) ?? null,
      reviewed_at: (r.reviewed_at as string | null) ?? null,
    }))
  })

// ---------------------------------------------------------------------------
// Adjustment / Reversal Report (spec §71).
// ---------------------------------------------------------------------------
export interface AdjustmentRow {
  id: string
  adjustment_number: string
  client_name: string | null
  type: string
  amount_bdt: string
  reason: string
  created_at: string
}

export const adjustmentReportFn = createServerFn({ method: 'GET' })
  .validator(reportFilterSchema)
  .handler(async ({ data }: { data: ReportFilter }): Promise<
    Array<AdjustmentRow>
  > => {
    await requireAdmin(PERMISSIONS.REPORTS_VIEW)
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('adjustments')
      .select(
        'id, adjustment_number, type, amount_bdt, reason, created_at, client:clients(name)',
      )
      .order('created_at', { ascending: false })
      .limit(1000)
    if (data.client_id) query = query.eq('client_id', data.client_id)
    if (data.from) query = query.gte('created_at', startOfDay(data.from))
    if (data.to) query = query.lte('created_at', endOfDay(data.to))
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      adjustment_number: r.adjustment_number as string,
      client_name: (r.client as { name: string } | null)?.name ?? null,
      type: r.type as string,
      amount_bdt: r.amount_bdt as string,
      reason: r.reason as string,
      created_at: r.created_at as string,
    }))
  })

// ---------------------------------------------------------------------------
// Ad Account Usage Report (spec §71) — accounts, status, current holder, limit.
// ---------------------------------------------------------------------------
export interface AccountUsageRow {
  id: string
  account_code: string
  name: string
  platform: string
  status: string
  current_limit_usd: string
  current_client: string | null
}

export const accountUsageReportFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<AccountUsageRow>> => {
    await requireAdmin(PERMISSIONS.REPORTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: accounts, error } = await admin
      .from('ad_accounts')
      .select(
        'id, account_code, name, platform, status, current_limit_usd',
      )
      .order('name')
    if (error) throw new Error(error.message)
    const rows = (accounts ?? []) as Array<Omit<AccountUsageRow, 'current_client'>>

    const { data: active } = await admin
      .from('ad_account_assignments')
      .select('ad_account_id, client:clients(name)')
      .eq('status', 'ACTIVE')
    const clientByAccount = new Map<string, string>()
    for (const a of (active ?? []) as unknown as Array<{
      ad_account_id: string
      client: { name: string } | null
    }>) {
      if (a.client) clientByAccount.set(a.ad_account_id, a.client.name)
    }

    return rows.map((r) => ({
      ...r,
      current_client: clientByAccount.get(r.id) ?? null,
    }))
  },
)

// ---------------------------------------------------------------------------
// USD Rate Usage Report (spec §71) — approved limits grouped by applied rate.
// ---------------------------------------------------------------------------
export interface RateUsageRow {
  rate: string
  approvals: number
  total_usd: string
  total_bdt: string
}

export const usdRateUsageReportFn = createServerFn({ method: 'GET' })
  .validator(reportFilterSchema)
  .handler(async ({ data }: { data: ReportFilter }): Promise<
    Array<RateUsageRow>
  > => {
    await requireAdmin(PERMISSIONS.REPORTS_VIEW)
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('limit_requests')
      .select('approved_usd_rate, approved_amount_usd, bdt_charge, reviewed_at')
      .eq('status', 'APPROVED')
      .limit(5000)
    if (data.from) query = query.gte('reviewed_at', startOfDay(data.from))
    if (data.to) query = query.lte('reviewed_at', endOfDay(data.to))
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)

    const grouped = new Map<
      string,
      { approvals: number; usd: ReturnType<typeof dec>; bdt: ReturnType<typeof dec> }
    >()
    for (const r of (rows ?? []) as Array<{
      approved_usd_rate: string | null
      approved_amount_usd: string | null
      bdt_charge: string | null
    }>) {
      const rate = r.approved_usd_rate ?? '0'
      const entry =
        grouped.get(rate) ?? { approvals: 0, usd: dec(0), bdt: dec(0) }
      entry.approvals += 1
      entry.usd = entry.usd.plus(r.approved_amount_usd ?? '0')
      entry.bdt = entry.bdt.plus(r.bdt_charge ?? '0')
      grouped.set(rate, entry)
    }
    return [...grouped.entries()]
      .map(([rate, v]) => ({
        rate,
        approvals: v.approvals,
        total_usd: v.usd.toFixed(2),
        total_bdt: v.bdt.toFixed(2),
      }))
      .sort((a, b) => Number(b.rate) - Number(a.rate))
  })
