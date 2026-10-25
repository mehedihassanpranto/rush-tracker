import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin, requireClientMembership } from '@/server/auth/guards.server'
import { adAccountScope, applyAdAccountScope } from '@/server/ad-accounts/scope.server'
import { readDailySpend, refreshDailySpend } from '@/server/meta/meta-daily-spend.service'
import { UserError } from '@/lib/errors/user-error'
import { dec } from '@/lib/money/money'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  DASHBOARD_PERIODS,
  addDays,
  daysBetween,
  dhakaDate,
  heldOnDay,
  periodRange,
  spendCacheRange,
} from '@/lib/dashboard/periods'
import type { SpendAccountRow } from '@/server/meta/meta-daily-spend.service'
import type { DashboardPeriod } from '@/lib/dashboard/periods'

/**
 * Agency dashboard period filter (owner request, 2026-10-23): USD spent on
 * Meta, limits approved and client payments for today / this week (from
 * Sunday) / this month / last month, with a day-by-day breakdown.
 *
 *   Spent      Meta's own daily spend (meta_daily_spend, 000067) on the
 *              agency's accounts — owned ∪ granted (scope.server.ts). USD
 *              accounts only (no FX); others are counted, not summed. A pool
 *              account's past days count for its current holder (grants keep
 *              no history).
 *   Approved   ledger LIMIT_APPROVAL rows by Asia/Dhaka day (USD and the BDT
 *              billed) — the same rule as the "today" cards.
 *   Collected  ledger PAYMENT rows by Asia/Dhaka day.
 */

const periodSchema = z.object({ period: z.enum(DASHBOARD_PERIODS) })
const money = (v: unknown) => (v == null ? '0.00' : dec(v as string | number).toFixed(2))

export interface PeriodDay {
  date: string
  spend_usd: string
  approved_limit_usd: string
  approved_billing_bdt: string
  collection_bdt: string
}

export interface PeriodTotals {
  period: DashboardPeriod
  from: string
  to: string
  totals: Omit<PeriodDay, 'date'>
  days: Array<PeriodDay>
  spend: {
    /** Latest Meta fetch for these accounts; null when nothing was ever fetched. */
    as_of: string | null
    accounts: number
    /** Accounts with spend in a currency other than USD — not in the USD total. */
    non_usd_accounts: number
  }
}

async function scopedSpendAccounts(organizationId: string): Promise<Array<SpendAccountRow>> {
  const admin = getSupabaseAdminClient()
  const scope = await adAccountScope(admin, organizationId)
  const { data, error } = await applyAdAccountScope(
    admin
      .from('ad_accounts')
      .select('id, external_account_id, is_platform, organization_id, meta_currency')
      .not('external_account_id', 'is', null),
    scope,
  )
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<SpendAccountRow>
}

export const agencyPeriodTotalsFn = createServerFn({ method: 'GET' })
  .validator(periodSchema)
  .handler(async ({ data }): Promise<PeriodTotals> => {
    const actor = await requireAdmin(PERMISSIONS.DASHBOARD_VIEW)
    const admin = getSupabaseAdminClient()
    const org = actor.organizationId
    const { from, to } = periodRange(data.period, new Date())

    const accounts = await scopedSpendAccounts(org)
    const ids = accounts.map((a) => a.id)
    const [ledger, spend] = await Promise.all([
      admin.rpc('agency_daily_totals', { p_organization_id: org, p_from: from, p_to: to }),
      readDailySpend(ids, from, to),
    ])
    if (ledger.error) throw new Error(ledger.error.message)

    const ledgerBy = new Map(
      ((ledger.data ?? []) as Array<Record<string, unknown>>).map((r) => [r.day as string, r]),
    )
    const spendBy = new Map<string, ReturnType<typeof dec>>()
    const nonUsd = new Set<string>()
    let asOf: string | null = null
    for (const r of spend) {
      if (!asOf || r.fetched_at > asOf) asOf = r.fetched_at
      if (r.currency && r.currency !== 'USD') {
        if (dec(r.spend).gt(0)) nonUsd.add(r.ad_account_id)
        continue
      }
      spendBy.set(r.spend_date, (spendBy.get(r.spend_date) ?? dec(0)).plus(r.spend))
    }

    const days = daysBetween(from, to).map((date) => {
      const l = ledgerBy.get(date)
      return {
        date,
        spend_usd: (spendBy.get(date) ?? dec(0)).toFixed(2),
        approved_limit_usd: money(l?.approved_limit_usd),
        approved_billing_bdt: money(l?.approved_billing_bdt),
        collection_bdt: money(l?.collection_bdt),
      }
    })
    const total = (k: keyof Omit<PeriodDay, 'date'>) => days.reduce((s, d) => s.plus(d[k]), dec(0)).toFixed(2)

    return {
      period: data.period,
      from,
      to,
      totals: {
        spend_usd: total('spend_usd'),
        approved_limit_usd: total('approved_limit_usd'),
        approved_billing_bdt: total('approved_billing_bdt'),
        collection_bdt: total('collection_bdt'),
      },
      days: days.reverse(),
      spend: { as_of: asOf, accounts: accounts.length, non_usd_accounts: nonUsd.size },
    }
  })

/** Fetch the agency's spend from Meta now (this month and last month). At
 * most once a minute per agency, so the button can't hammer Meta's API. */
export const refreshAgencySpendFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ refreshed: number; failed: number }> => {
    const actor = await requireAdmin(PERMISSIONS.DASHBOARD_VIEW)
    const accounts = await scopedSpendAccounts(actor.organizationId)
    if (accounts.length === 0) return { refreshed: 0, failed: 0 }
    const { data: latest } = await getSupabaseAdminClient()
      .from('meta_daily_spend')
      .select('fetched_at')
      .in('ad_account_id', accounts.map((a) => a.id))
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latest && Date.now() - new Date(latest.fetched_at as string).getTime() < 60_000) {
      throw new UserError('Spend was refreshed less than a minute ago — try again shortly')
    }
    const { from, to } = spendCacheRange(new Date())
    return refreshDailySpend(accounts, from, to)
  },
)

// ------------------------------------------------------------------ client ---

/**
 * The same figures for one client (owner request, 2026-10-23), scoped to the
 * client the login is currently viewing (requireClientMembership):
 *
 *   Spent      Meta's daily spend on ad accounts while they were assigned to
 *              THIS client: from the day assigned up to (not including) the
 *              day released — on a transfer day the account counts for its
 *              new client. USD accounts only.
 *   Approved / You paid   this client's ledger by Asia/Dhaka day.
 */
interface ClientAssignment {
  ad_account_id: string
  assigned_at: string
  released_at: string | null
  ad_account: SpendAccountRow | null
}

async function clientAssignments(clientId: string, organizationId: string): Promise<Array<ClientAssignment>> {
  const { data, error } = await getSupabaseAdminClient()
    .from('ad_account_assignments')
    .select('ad_account_id, assigned_at, released_at, ad_account:ad_accounts(id, external_account_id, is_platform, organization_id, meta_currency)')
    .eq('client_id', clientId)
    .eq('organization_id', organizationId)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as Array<ClientAssignment>
}


interface ClientLedgerRow {
  type: string
  usd_amount: number | null
  debit_bdt: number
  credit_bdt: number
  created_at: string
}

/** The client's approvals and payments over Dhaka days [from, to], in pages
 * (a read stops at 1,000 rows). */
async function clientLedger(clientId: string, organizationId: string, from: string, to: string): Promise<Array<ClientLedgerRow>> {
  const admin = getSupabaseAdminClient()
  const out: Array<ClientLedgerRow> = []
  for (let at = 0; ; at += 1000) {
    const { data, error } = await admin
      .from('ledger_entries')
      .select('type, usd_amount, debit_bdt, credit_bdt, created_at')
      .eq('client_id', clientId)
      .eq('organization_id', organizationId)
      .in('type', ['LIMIT_APPROVAL', 'PAYMENT'])
      .gte('created_at', new Date(`${from}T00:00:00+06:00`).toISOString())
      .lt('created_at', new Date(`${addDays(to, 1)}T00:00:00+06:00`).toISOString())
      .order('id')
      .range(at, at + 999)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as Array<ClientLedgerRow>))
    if ((data ?? []).length < 1000) break
  }
  return out
}

export const clientPeriodTotalsFn = createServerFn({ method: 'GET' })
  .validator(periodSchema)
  .handler(async ({ data }): Promise<PeriodTotals> => {
    const { user, membership } = await requireClientMembership()
    const { from, to } = periodRange(data.period, new Date())

    const assignments = await clientAssignments(membership.clientId, user.organizationId)
    const accountIds = [...new Set(assignments.map((a) => a.ad_account_id))]
    const [ledger, spend] = await Promise.all([
      clientLedger(membership.clientId, user.organizationId, from, to),
      readDailySpend(accountIds, from, to),
    ])

    const now = new Date()
    const heldOn = (accountId: string, day: string) =>
      heldOnDay(assignments.filter((a) => a.ad_account_id === accountId), day, now)

    const spendBy = new Map<string, ReturnType<typeof dec>>()
    const nonUsd = new Set<string>()
    let asOf: string | null = null
    for (const r of spend) {
      if (!heldOn(r.ad_account_id, r.spend_date)) continue
      if (!asOf || r.fetched_at > asOf) asOf = r.fetched_at
      if (r.currency && r.currency !== 'USD') {
        if (dec(r.spend).gt(0)) nonUsd.add(r.ad_account_id)
        continue
      }
      spendBy.set(r.spend_date, (spendBy.get(r.spend_date) ?? dec(0)).plus(r.spend))
    }
    const ledgerBy = new Map<string, { usd: ReturnType<typeof dec>; billed: ReturnType<typeof dec>; paid: ReturnType<typeof dec> }>()
    for (const l of ledger) {
      const day = dhakaDate(new Date(l.created_at))
      const t = ledgerBy.get(day) ?? { usd: dec(0), billed: dec(0), paid: dec(0) }
      if (l.type === 'LIMIT_APPROVAL') {
        t.usd = t.usd.plus(l.usd_amount ?? 0)
        t.billed = t.billed.plus(l.debit_bdt)
      } else {
        t.paid = t.paid.plus(l.credit_bdt)
      }
      ledgerBy.set(day, t)
    }

    const days = daysBetween(from, to).map((date) => {
      const l = ledgerBy.get(date)
      return {
        date,
        spend_usd: (spendBy.get(date) ?? dec(0)).toFixed(2),
        approved_limit_usd: (l?.usd ?? dec(0)).toFixed(2),
        approved_billing_bdt: (l?.billed ?? dec(0)).toFixed(2),
        collection_bdt: (l?.paid ?? dec(0)).toFixed(2),
      }
    })
    const total = (k: keyof Omit<PeriodDay, 'date'>) => days.reduce((s, d) => s.plus(d[k]), dec(0)).toFixed(2)
    const activeAccounts = new Set(assignments.filter((a) => !a.released_at).map((a) => a.ad_account_id))

    return {
      period: data.period,
      from,
      to,
      totals: {
        spend_usd: total('spend_usd'),
        approved_limit_usd: total('approved_limit_usd'),
        approved_billing_bdt: total('approved_billing_bdt'),
        collection_bdt: total('collection_bdt'),
      },
      days: days.reverse(),
      spend: { as_of: asOf, accounts: activeAccounts.size, non_usd_accounts: nonUsd.size },
    }
  })

/** Fetch the client's current accounts' spend from Meta now — at most once a
 * minute, like the agency's. */
export const refreshClientSpendFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ refreshed: number; failed: number }> => {
    const { user, membership } = await requireClientMembership()
    const accounts = (await clientAssignments(membership.clientId, user.organizationId))
      .filter((a) => !a.released_at && a.ad_account?.external_account_id)
      .map((a) => a.ad_account!)
    if (accounts.length === 0) return { refreshed: 0, failed: 0 }
    const { data: latest } = await getSupabaseAdminClient()
      .from('meta_daily_spend')
      .select('fetched_at')
      .in('ad_account_id', accounts.map((a) => a.id))
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latest && Date.now() - new Date(latest.fetched_at as string).getTime() < 60_000) {
      throw new UserError('Spend was refreshed less than a minute ago — try again shortly')
    }
    const { from, to } = spendCacheRange(new Date())
    return refreshDailySpend(accounts, from, to)
  },
)
