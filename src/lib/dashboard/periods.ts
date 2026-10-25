/**
 * Dashboard periods (owner request, 2026-10-23), as Asia/Dhaka calendar days
 * — the business day used everywhere else in the app. Weeks start on SUNDAY
 * (owner's choice: the Bangladesh work week). Pure, so it is unit tested.
 * Dates are YYYY-MM-DD strings, `to` inclusive.
 */

export const DASHBOARD_PERIODS = ['today', 'week', 'month', 'last_month'] as const
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]

export const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  last_month: 'Last month',
}

/** Today's date in Asia/Dhaka. */
export function dhakaDate(now: Date): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number)
  return [y, m, d]
}

function fmt(y: number, m: number, d: number): string {
  // Date.UTC normalises overflow (month 0 → December of the year before).
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.toISOString().slice(0, 10)
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day)
  return fmt(y, m, d + n)
}

export function periodRange(period: DashboardPeriod, now: Date): { from: string; to: string } {
  const today = dhakaDate(now)
  const [y, m, d] = parts(today)
  switch (period) {
    case 'today':
      return { from: today, to: today }
    case 'week': {
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
      return { from: addDays(today, -weekday), to: today }
    }
    case 'month':
      return { from: fmt(y, m, 1), to: today }
    case 'last_month':
      return { from: fmt(y, m - 1, 1), to: fmt(y, m, 0) }
  }
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): Array<string> {
  const out: Array<string> = []
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day)
  return out
}

/** The span kept fresh in the spend cache: first day of last month → today.
 * Covers every period the dashboard offers. */
export function spendCacheRange(now: Date): { from: string; to: string } {
  return { from: periodRange('last_month', now).from, to: dhakaDate(now) }
}

/**
 * Whether a client held an ad account on a Dhaka day, given its assignments of
 * that account: from the day assigned up to (not including) the day released,
 * so on a transfer day the account counts for its new client only. Still
 * assigned → held through today.
 */
export function heldOnDay(
  assignments: Array<{ assigned_at: string; released_at: string | null }>,
  day: string,
  now: Date,
): boolean {
  return assignments.some((a) => {
    const start = dhakaDate(new Date(a.assigned_at))
    const end = a.released_at ? dhakaDate(new Date(a.released_at)) : addDays(dhakaDate(now), 1)
    return day >= start && day < end
  })
}
