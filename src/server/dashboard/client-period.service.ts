import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { readDailySpend, refreshDailySpend } from '@/server/meta/meta-daily-spend.service'
import { UserError } from '@/lib/errors/user-error'
import { dec } from '@/lib/money/money'
import {
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
 * One client's period figures (owner requests, 2026-10-23 and 2026-10-26),
 * shared by the client's own dashboard and the agency's client page. The
 * caller has already checked who may see this client; every read here is
 * still scoped to `organizationId`.
 *
 *   Spent      Meta's daily spend on ad accounts while they were assigned to
 *              THIS client: from the day assigned up to (not including) the
 *              day released — on a transfer day the account counts for its
 *              new client (heldOnDay()). USD accounts only.
 *   Approved / Paid   this client's ledger by Asia/Dhaka day.
 */

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

export async function clientPeriodTotals(
  clientId: string,
  organizationId: string,
  period: DashboardPeriod,
): Promise<PeriodTotals> {
  const now = new Date()
  const { from, to } = periodRange(period, now)

  const assignments = await clientAssignments(clientId, organizationId)
  const accountIds = [...new Set(assignments.map((a) => a.ad_account_id))]
  const [ledger, spend] = await Promise.all([
    clientLedger(clientId, organizationId, from, to),
    readDailySpend(accountIds, from, to),
  ])

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
    period,
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
}

/** Fetch the client's current accounts' spend from Meta now — at most once a
 * minute, like the agency's. */
export async function refreshClientSpend(
  clientId: string,
  organizationId: string,
): Promise<{ refreshed: number; failed: number }> {
  const accounts = (await clientAssignments(clientId, organizationId))
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
}
