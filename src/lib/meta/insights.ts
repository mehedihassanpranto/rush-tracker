import { dec } from '@/lib/money/money'
import { daysBetween } from '@/lib/dashboard/periods'

/**
 * Meta Insights daily spend (GET act_…/insights?fields=spend,account_currency
 * &time_increment=1). Each row is one day in the AD ACCOUNT's timezone;
 * `spend` is a decimal string in the account's currency, major units (unlike
 * the account node's amount_spent, which is minor units — see toSummary()).
 * Days without spend are simply absent. Pure, so it is unit tested.
 */
export interface InsightsDailyRow {
  spend?: string
  account_currency?: string
  date_start?: string
  date_stop?: string
}

export interface DailySpend {
  date: string
  spend: string
  currency: string | null
}

/** One entry for every day in [from, to]: Meta's figure, or 0 for a day Meta
 * returned nothing for (no spend). Rows outside the range are ignored. */
export function dailySpendFromInsights(
  rows: Array<InsightsDailyRow>,
  from: string,
  to: string,
  fallbackCurrency: string | null,
): Array<DailySpend> {
  const byDay = new Map<string, InsightsDailyRow>()
  for (const r of rows) {
    if (r.date_start && r.date_start >= from && r.date_start <= to) byDay.set(r.date_start, r)
  }
  const currency = rows.find((r) => r.account_currency)?.account_currency ?? fallbackCurrency
  return daysBetween(from, to).map((date) => {
    const r = byDay.get(date)
    const spend = r?.spend ? dec(r.spend) : dec(0)
    return { date, spend: (spend.isNegative() ? dec(0) : spend).toFixed(2), currency }
  })
}
