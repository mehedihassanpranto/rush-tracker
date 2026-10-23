import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { adAccountScope, applyAdAccountScope } from '@/server/ad-accounts/scope.server'
import { readDailySpend, refreshDailySpend } from '@/server/meta/meta-daily-spend.service'
import { UserError } from '@/lib/errors/user-error'
import { dec } from '@/lib/money/money'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  DASHBOARD_PERIODS,
  daysBetween,
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
