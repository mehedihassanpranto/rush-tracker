import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import {
  adAccountScope,
  applyAdAccountScope,
} from '@/server/ad-accounts/scope.server'
import {
  combineAllocation,
  latestOf,
  totalTodayApprovals,
} from '@/lib/finance/agency-allocations'
import { computeSourceWiseStock } from '@/lib/finance/usd-stock'
import type { TodayApprovalRow } from '@/lib/finance/agency-allocations'
import type { SourceWiseStock } from '@/lib/finance/usd-stock'
import { dec } from '@/lib/money/money'
import {
  agencyAdAccountsSchema,
  usdPurchaseCreateSchema,
  usdPurchaseListSchema,
  usdSaleCreateSchema,
  usdSaleListSchema,
  usdSourceCreateSchema,
  usdSourceStatusSchema,
  usdSourceUpdateSchema,
} from '@/schemas/platform-finance'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AdAccount,
  AgencyLimitApproval,
  AgencyUsdSummaryRow,
  UsdPurchaseWithSource,
  UsdSaleWithRefs,
  UsdSource,
  UsdStockSummary,
} from '@/types/domain'

/**
 * Platform Management -> Finance & Accounts: the USD/BDT stock ledger
 * (spec §6). Every fn is requirePlatformAdmin()-gated and none of them takes
 * an organization from the session: this is the platform's own book, spanning
 * every agency.
 *
 * WHAT MUST NEVER HAPPEN: any of purchases, sources or buying rates reaching
 * an agency (spec §6.5). Nothing here is reachable without requirePlatformAdmin,
 * and the tables refuse anon/authenticated outright (migration 000041).
 *
 * AUDIT PLACEMENT — read before "fixing" it. Purchases and sources are
 * deliberately NOT written to audit_logs. That table needs an organization_id,
 * and the platform's own home organization is org zero, which is ALSO xRush
 * Agency — whose admins read that log at /agency/audit. Auditing a purchase
 * there would hand a customer the platform's cost basis. The rows are
 * insert-only and carry recorded_by + created_at, which is the trail. A sale
 * IS audited, into the BUYING agency's own log (it may see what it bought, at
 * what rate — spec §6.5), the same principle as request decisions.
 *
 * Insert-only in v1: no edit or void. Spec §10 leaves that open (a typo in a
 * BDT amount would need a correction path with its own audit trail); until it
 * is decided a wrong row is fixed in the database, not through the app.
 */

const num = (v: unknown): string => (v == null ? '0' : dec(v as string | number).toString())
const numOrNull = (v: unknown): string | null =>
  v == null ? null : dec(v as string | number).toString()

function friendlyDuplicate(message: string, code?: string): string | null {
  return code === '23505' || /duplicate key/i.test(message)
    ? 'A source with that name already exists.'
    : null
}

// ---------------------------------------------------------------- overview ---

export const getUsdStockSummaryFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UsdStockSummary> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    // Always exactly one row (two aggregate CTEs), even on an empty ledger.
    const { data, error } = await admin.from('usd_stock_summary').select('*').single()
    if (error) throw new Error(error.message)
    const r = data as Record<string, unknown>
    return {
      total_usd_purchased: num(r.total_usd_purchased),
      total_bdt_invested: num(r.total_bdt_invested),
      total_usd_sold: num(r.total_usd_sold),
      total_bdt_received: num(r.total_bdt_received),
      remaining_usd_stock: num(r.remaining_usd_stock),
      avg_buying_rate: numOrNull(r.avg_buying_rate),
      avg_selling_rate: numOrNull(r.avg_selling_rate),
      remaining_stock_bdt_value: numOrNull(r.remaining_stock_bdt_value),
      gross_bdt_difference: numOrNull(r.gross_bdt_difference),
    }
  },
)

// ----------------------------------------------------------------- sources ---

function sortSources<T extends { name: string }>(rows: Array<T>): Array<T> {
  return [...rows].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
}

export const listUsdSourcesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<UsdSource>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin.from('usd_sources').select('*')
    if (error) throw new Error(error.message)
    return sortSources((data ?? []) as Array<UsdSource>)
  },
)

export const createUsdSourceFn = createServerFn({ method: 'POST' })
  .validator(usdSourceCreateSchema)
  .handler(async ({ data }): Promise<UsdSource> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: row, error } = await admin
      .from('usd_sources')
      .insert({ name: data.name, payment_method: data.payment_method })
      .select('*')
      .single()
    if (error) {
      throw new Error(friendlyDuplicate(error.message, error.code) ?? error.message)
    }
    return row as UsdSource
  })

/** Rename a source or set how it pays in USD. This is also how a source that
 * predates the payment_method column gets one. Past purchases keep pointing at
 * the same source id, so nothing recorded is disturbed. */
export const updateUsdSourceFn = createServerFn({ method: 'POST' })
  .validator(usdSourceUpdateSchema)
  .handler(async ({ data }): Promise<UsdSource> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: updated, error } = await admin
      .from('usd_sources')
      .update({ name: data.name, payment_method: data.payment_method })
      .eq('id', data.id)
      .select('*')
    if (error) {
      throw new Error(friendlyDuplicate(error.message, error.code) ?? error.message)
    }
    if (!updated || updated.length === 0) throw new Error('Source not found')
    return updated[0] as UsdSource
  })

export const setUsdSourceActiveFn = createServerFn({ method: 'POST' })
  .validator(usdSourceStatusSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: updated, error } = await admin
      .from('usd_sources')
      .update({ is_active: data.is_active })
      .eq('id', data.id)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) throw new Error('Source not found')
    return { ok: true }
  })

/**
 * Supabase caps a plain select at 1,000 rows and truncates SILENTLY, which for
 * a FIFO walk would quietly drop the newest purchases and overstate what is
 * left. Page until a short page comes back. (Totals never depend on this: they
 * come from the aggregate views, which have no row limit.)
 */
async function fetchAllPurchaseLots(admin: SupabaseClient) {
  const PAGE = 1000
  const rows: Array<{
    source_id: string
    usd_amount: string
    bdt_amount: string
    purchased_at: string
  }> = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('usd_purchases')
      .select('source_id, usd_amount, bdt_amount, purchased_at')
      .order('purchased_at', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as typeof rows
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return rows
}

export interface SourceWiseStockReport extends SourceWiseStock {
  active_source_count: number
}

/** Purchased / allocated / remaining per source, FIFO-depleted (spec §6.3). */
export const getSourceWiseStockFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SourceWiseStockReport> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const [sourcesRes, lots, soldRes] = await Promise.all([
      admin.from('usd_sources').select('id, name, payment_method, is_active'),
      fetchAllPurchaseLots(admin),
      admin.from('usd_stock_summary').select('total_usd_sold').single(),
    ])
    if (sourcesRes.error) throw new Error(sourcesRes.error.message)
    if (soldRes.error) throw new Error(soldRes.error.message)

    const sources = (sourcesRes.data ?? []) as Array<{
      id: string
      name: string
      payment_method: string | null
      is_active: boolean
    }>
    const totalSold = num((soldRes.data as { total_usd_sold: unknown }).total_usd_sold)
    const report = computeSourceWiseStock(sources, lots, totalSold)
    return {
      ...report,
      active_source_count: sources.filter((s) => s.is_active).length,
    }
  },
)

// --------------------------------------------------------------- purchases ---

export const listUsdPurchasesFn = createServerFn({ method: 'GET' })
  .validator(usdPurchaseListSchema)
  .handler(async ({ data }): Promise<Array<UsdPurchaseWithSource>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('usd_purchases')
      .select('*, source:usd_sources(id, name, payment_method)')
      .order('purchased_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500)
    if (data.source_id) query = query.eq('source_id', data.source_id)
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return (rows ?? []) as unknown as Array<UsdPurchaseWithSource>
  })

export const createUsdPurchaseFn = createServerFn({ method: 'POST' })
  .validator(usdPurchaseCreateSchema)
  .handler(async ({ data }): Promise<UsdPurchaseWithSource> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: source } = await admin
      .from('usd_sources')
      .select('id, name, is_active')
      .eq('id', data.source_id)
      .maybeSingle()
    if (!source) throw new Error('Source not found')
    if (!(source as { is_active: boolean }).is_active) {
      throw new Error('That source is deactivated — reactivate it before recording a purchase.')
    }

    const { data: row, error } = await admin
      .from('usd_purchases')
      .insert({
        source_id: data.source_id,
        usd_amount: dec(data.usd_amount).toDecimalPlaces(2).toNumber(),
        bdt_amount: dec(data.bdt_amount).toDecimalPlaces(2).toNumber(),
        method: data.method ?? null,
        purchased_at: data.purchased_at ?? new Date().toISOString(),
        notes: data.notes ?? null,
        recorded_by: actor.id,
      })
      .select('*, source:usd_sources(id, name, payment_method)')
      .single()
    if (error) throw new Error(error.message)
    // No audit row — see the AUDIT PLACEMENT note at the top of this file.
    return row as unknown as UsdPurchaseWithSource
  })

// ------------------------------------------------------------------- sales ---

const SALE_SELECT =
  '*, organization:organizations(id, name), ad_account:ad_accounts(id, account_code, name)'

export const listUsdSalesFn = createServerFn({ method: 'GET' })
  .validator(usdSaleListSchema)
  .handler(async ({ data }): Promise<Array<UsdSaleWithRefs>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('usd_sales')
      .select(SALE_SELECT)
      .order('sold_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(data.limit ?? 500)
    if (data.organization_id) query = query.eq('organization_id', data.organization_id)
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return (rows ?? []) as unknown as Array<UsdSaleWithRefs>
  })

export const createUsdSaleFn = createServerFn({ method: 'POST' })
  .validator(usdSaleCreateSchema)
  .handler(async ({ data }): Promise<UsdSaleWithRefs> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: org } = await admin
      .from('organizations')
      .select('id, name')
      .eq('id', data.organization_id)
      .maybeSingle()
    if (!org) throw new Error('Agency not found')
    const agency = org as { id: string; name: string }

    // An earmarked account must actually be one this agency can use (owned, or
    // granted from the pool) — otherwise the record would tie a sale to an
    // account the agency has no access to.
    if (data.ad_account_id) {
      const { data: usable, error: rpcError } = await admin.rpc('org_can_use_ad_account', {
        p_account_id: data.ad_account_id,
        p_organization_id: agency.id,
      })
      if (rpcError) throw new Error(rpcError.message)
      if (usable !== true) {
        throw new Error(`That ad account is not available to ${agency.name}.`)
      }
    }

    const { data: row, error } = await admin
      .from('usd_sales')
      .insert({
        organization_id: agency.id,
        agency_name: agency.name,
        ad_account_id: data.ad_account_id ?? null,
        usd_amount: dec(data.usd_amount).toDecimalPlaces(2).toNumber(),
        bdt_amount: dec(data.bdt_amount).toDecimalPlaces(2).toNumber(),
        sold_at: data.sold_at ?? new Date().toISOString(),
        notes: data.notes ?? null,
        recorded_by: actor.id,
      })
      .select(SALE_SELECT)
      .single()
    if (error) throw new Error(error.message)
    const sale = row as unknown as UsdSaleWithRefs

    // Into the BUYING agency's log, not the platform's: it may see its own
    // purchase (spec §6.5), and the platform's home org is xRush's.
    await writeAudit({
      actorUserId: actor.id,
      organizationId: agency.id,
      action: 'USD_SALE_RECORDED',
      entityType: 'USD_SALE',
      entityId: sale.id,
      newValues: {
        reference_id: sale.reference_id,
        usd_amount: sale.usd_amount,
        bdt_amount: sale.bdt_amount,
        selling_rate: sale.selling_rate,
        ad_account_id: sale.ad_account_id,
      },
    })
    return sale
  })

/** Ad accounts an agency can use (owned or granted) — the earmark picker. */
export const listAgencyAdAccountsFn = createServerFn({ method: 'GET' })
  .validator(agencyAdAccountsSchema)
  .handler(
    async ({ data }): Promise<Array<Pick<AdAccount, 'id' | 'account_code' | 'name'>>> => {
      await requirePlatformAdmin()
      const admin = getSupabaseAdminClient()
      const scope = await adAccountScope(admin, data.organization_id)
      const { data: rows, error } = await applyAdAccountScope(
        admin.from('ad_accounts').select('id, account_code, name').order('account_code'),
        scope,
      )
      if (error) throw new Error(error.message)
      return (rows ?? []) as Array<Pick<AdAccount, 'id' | 'account_code' | 'name'>>
    },
  )

// ---------------------------------------------------------- agency summary ---

/**
 * Every agency with what the platform has allocated to it in USD (spec §6.4):
 * the sales recorded by hand PLUS the approved limit requests on platform-owned
 * accounts (migration 000043). Agencies that have never been allocated anything
 * are listed with zeros, so "number of agencies" is the real count; sales whose
 * agency was since deleted appear as their own "removed" lines rather than
 * vanishing from the totals.
 *
 * BDT paid, the sale count and the average selling rate come from RECORDED
 * SALES ONLY — a limit approval carries no BDT (the client pays the agency, and
 * what the agency pays the platform for it is not on the request), so folding
 * its USD into a rate would dilute it toward nonsense. The stock position
 * (usd_stock_summary) is deliberately untouched by approvals for the same reason.
 */
export const getAgencyUsdSummaryFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<AgencyUsdSummaryRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const [orgsRes, summaryRes, limitsRes] = await Promise.all([
      admin.from('organizations').select('id, name, subscription_status'),
      admin.from('agency_usd_summary').select('*'),
      admin.from('agency_limit_approvals_summary').select('*'),
    ])
    if (orgsRes.error) throw new Error(orgsRes.error.message)
    if (summaryRes.error) throw new Error(summaryRes.error.message)
    if (limitsRes.error) throw new Error(limitsRes.error.message)

    type SummaryRaw = {
      organization_id: string | null
      removed_agency_name: string | null
      total_usd_allocated: unknown
      total_bdt_paid: unknown
      transaction_count: unknown
      last_transaction_at: string | null
      avg_selling_rate: unknown
    }
    type LimitsRaw = {
      organization_id: string
      total_usd_approved: unknown
      approval_count: unknown
      last_approved_at: string | null
      today_usd_approved: unknown
      today_approval_count: unknown
    }
    const byOrg = new Map<string, SummaryRaw>()
    const removed: Array<SummaryRaw> = []
    for (const r of (summaryRes.data ?? []) as Array<SummaryRaw>) {
      if (r.organization_id) byOrg.set(r.organization_id, r)
      else removed.push(r)
    }
    const limitsByOrg = new Map<string, LimitsRaw>()
    for (const r of (limitsRes.data ?? []) as Array<LimitsRaw>) {
      limitsByOrg.set(r.organization_id, r)
    }

    const toRow = (
      sales: SummaryRaw | undefined,
      limits: LimitsRaw | undefined,
      base: Pick<AgencyUsdSummaryRow, 'organization_id' | 'name' | 'removed' | 'subscription_status'>,
    ): AgencyUsdSummaryRow => {
      const usd = combineAllocation(
        sales ? num(sales.total_usd_allocated) : null,
        limits ? num(limits.total_usd_approved) : null,
      )
      return {
        ...base,
        sales_usd: usd.sales_usd,
        limits_usd: usd.limits_usd,
        total_usd_allocated: usd.total_usd,
        total_bdt_paid: num(sales?.total_bdt_paid),
        transaction_count: Number(sales?.transaction_count ?? 0),
        limit_approval_count: Number(limits?.approval_count ?? 0),
        limits_today_usd: num(limits?.today_usd_approved),
        limits_today_count: Number(limits?.today_approval_count ?? 0),
        last_activity_at: latestOf(sales?.last_transaction_at, limits?.last_approved_at),
        avg_selling_rate: numOrNull(sales?.avg_selling_rate),
      }
    }

    const rows: Array<AgencyUsdSummaryRow> = (
      (orgsRes.data ?? []) as Array<{
        id: string
        name: string
        subscription_status: string
      }>
    ).map((o) =>
      toRow(byOrg.get(o.id), limitsByOrg.get(o.id), {
        organization_id: o.id,
        name: o.name,
        removed: false,
        subscription_status: o.subscription_status,
      }),
    )
    for (const r of removed) {
      // A deleted agency's limit requests went with it (offboarding), so a
      // removed line only ever has sales.
      rows.push(
        toRow(r, undefined, {
          organization_id: null,
          name: r.removed_agency_name ?? 'Removed agency',
          removed: true,
          subscription_status: null,
        }),
      )
    }

    // Biggest allocations first; agencies with none fall to the bottom
    // alphabetically.
    return rows.sort(
      (a, b) =>
        dec(b.total_usd_allocated).comparedTo(dec(a.total_usd_allocated)) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    )
  },
)

/**
 * Today's approved limit requests across every agency — the "Today" card on the
 * USD Stock tab. Today is the Asia/Dhaka business day, decided by the database
 * (the view), the same day the agency dashboard's own "today" figures use.
 * Display only: it feeds nothing in the stock position.
 */
export interface TodayLimitApprovals {
  usd: string
  count: number
  /** The business day these figures are for, YYYY-MM-DD in Asia/Dhaka. */
  day: string
}

export const getTodayLimitApprovalsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<TodayLimitApprovals> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    // One row per agency, so this is small and never near the row cap.
    const { data, error } = await admin
      .from('agency_limit_approvals_summary')
      .select('today_usd_approved, today_approval_count')
    if (error) throw new Error(error.message)
    const total = totalTodayApprovals((data ?? []) as Array<TodayApprovalRow>)
    return {
      ...total,
      day: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }),
    }
  },
)

/**
 * One agency's approved limit requests on platform-owned accounts, newest
 * first — the rows behind the "limits" half of its USD allocated. Capped at 500;
 * the total on the summary comes from the view and has no such cap.
 */
export const listAgencyLimitApprovalsFn = createServerFn({ method: 'GET' })
  .validator(agencyAdAccountsSchema)
  .handler(async ({ data }): Promise<Array<AgencyLimitApproval>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: rows, error } = await admin
      .from('limit_requests')
      .select(
        'id, request_number, approved_amount_usd, approved_at, ad_account:ad_accounts!inner(id, account_code, name, is_platform)',
      )
      .eq('organization_id', data.organization_id)
      .eq('status', 'APPROVED')
      .eq('ad_account.is_platform', true)
      .order('approved_at', { ascending: false })
      .limit(500)
    if (error) throw new Error(error.message)
    return (rows ?? []).map((r) => {
      const row = r as unknown as {
        id: string
        request_number: string
        approved_amount_usd: string | number | null
        approved_at: string | null
        ad_account: { id: string; account_code: string; name: string }
      }
      return {
        id: row.id,
        request_number: row.request_number,
        approved_amount_usd: num(row.approved_amount_usd),
        approved_at: row.approved_at,
        ad_account: {
          id: row.ad_account.id,
          account_code: row.ad_account.account_code,
          name: row.ad_account.name,
        },
      }
    })
  })
