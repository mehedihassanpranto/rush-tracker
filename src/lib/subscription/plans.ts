/**
 * Subscription plan rules shared by the server (enforcement) and the UI
 * (usage bars, billing badges). Pure — no database, no server imports — so it
 * is unit-tested directly and safe in client bundles.
 */

export type PlanLimitKind = 'clients' | 'adAccounts' | 'staff'

export interface SubscriptionPlan {
  id: string
  name: string
  monthly_fee_bdt: string
  /** null = unlimited */
  max_clients: number | null
  max_ad_accounts: number | null
  max_staff: number | null
  is_active: boolean
  sort_order: number
}

export interface OrganizationUsage {
  clients: number
  adAccounts: number
  staff: number
}

export const LIMIT_LABELS: Record<PlanLimitKind, { one: string; many: string }> = {
  clients: { one: 'active client', many: 'active clients' },
  adAccounts: { one: 'ad account', many: 'ad accounts' },
  staff: { one: 'active staff login', many: 'active staff logins' },
}

export function planLimit(
  plan: Pick<SubscriptionPlan, 'max_clients' | 'max_ad_accounts' | 'max_staff'> | null,
  kind: PlanLimitKind,
): number | null {
  if (!plan) return null
  if (kind === 'clients') return plan.max_clients
  if (kind === 'adAccounts') return plan.max_ad_accounts
  return plan.max_staff
}

/**
 * Would adding `adding` more of `kind` stay within the limit? `null` limit (or
 * no plan) is unlimited. Being AT the limit is fine; going over is not. An
 * agency already over its limit (e.g. after a downgrade) is never forced to
 * delete anything — it just can't add more until it's back under.
 */
export function checkPlanLimit(
  used: number,
  adding: number,
  limit: number | null,
): { ok: true } | { ok: false; used: number; limit: number } {
  if (limit === null) return { ok: true }
  if (used + adding <= limit) return { ok: true }
  return { ok: false, used, limit }
}

export function planLimitMessage(
  kind: PlanLimitKind,
  planName: string,
  used: number,
  limit: number,
  adding = 1,
): string {
  const label = LIMIT_LABELS[kind]
  const what = adding === 1 ? `another ${label.one}` : `${adding} more ${label.many}`
  return (
    `Your ${planName} plan allows ${limit} ${limit === 1 ? label.one : label.many} ` +
    `and you have ${used}, so ${what} can't be added. ` +
    `Ask the platform to move you to a larger plan.`
  )
}

export type BillingStatus = 'exempt' | 'no_plan' | 'unpaid' | 'paid' | 'overdue'

/**
 * Where an agency stands on paying for its plan.
 * - exempt: billing_exempt (e.g. the deployment's own agency)
 * - no_plan: no plan assigned, or a free (৳0) plan
 * - unpaid: has a paid plan but no payment recorded yet
 * - paid: the latest covered period ends today or later
 * - overdue: the latest covered period ended before today
 * `today` and `paidThrough` are YYYY-MM-DD strings (business days in
 * Asia/Dhaka — see dhakaToday()).
 */
export function billingStatus(input: {
  billingExempt: boolean
  planFeeBdt: string | number | null
  paidThrough: string | null
  today: string
}): BillingStatus {
  if (input.billingExempt) return 'exempt'
  if (input.planFeeBdt === null || Number(input.planFeeBdt) <= 0) return 'no_plan'
  if (!input.paidThrough) return 'unpaid'
  return input.paidThrough >= input.today ? 'paid' : 'overdue'
}

/** Today's date in Asia/Dhaka as YYYY-MM-DD (the app's business day). */
export function dhakaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Latest period_end across an agency's payments, or null if none. */
export function paidThroughFrom(
  payments: Array<{ period_end: string }>,
): string | null {
  let latest: string | null = null
  for (const p of payments) {
    if (latest === null || p.period_end > latest) latest = p.period_end
  }
  return latest
}

/**
 * Default period for a new payment: starts the day after the current paid
 * period ends (or today if never paid / lapsed), and runs one calendar month
 * minus a day — e.g. 2026-10-05 → 2026-11-04.
 */
export function nextPeriod(
  paidThrough: string | null,
  today: string,
  months = 1,
): { start: string; end: string } {
  const startDate =
    paidThrough && paidThrough >= today ? addDays(paidThrough, 1) : today
  const end = addDays(addMonths(startDate, months), -1)
  return { start: startDate, end }
}

function parse(d: string): Date {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(d: string, days: number): string {
  const x = parse(d)
  x.setUTCDate(x.getUTCDate() + days)
  return fmt(x)
}

/** Calendar-month add that clamps to the target month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(d: string, months: number): string {
  const x = parse(d)
  const day = x.getUTCDate()
  x.setUTCDate(1)
  x.setUTCMonth(x.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()
  x.setUTCDate(Math.min(day, lastDay))
  return fmt(x)
}
