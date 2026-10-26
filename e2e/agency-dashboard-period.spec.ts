import { expect, test } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient } from './support/seed'

/**
 * Agency dashboard period filter (migration 000067): USD spent (Meta's daily
 * spend, cached), limit approved and paid by clients — Today, Yesterday, then This month
 * with its day-by-day table. Seeds org A's own data; global teardown deletes
 * org A's ledger and ad accounts (and so the cached spend with them).
 */
test.use(auth('agencyA'))

const dhakaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
const dhakaYesterday = () => new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
const dhakaStart = (day: string) => new Date(`${day}T00:00:00+06:00`).toISOString()
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const bdt = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

/**
 * What org A's dashboard should show for [from, to], read straight from the
 * database — other specs (and a retry of this one) add to the same books.
 */
async function expected(from: string, to: string) {
  const admin = adminClient(loadE2EEnv())
  const { orgA } = fixtures()
  const { data: accts } = await admin.from('ad_accounts').select('id').eq('organization_id', orgA)
  const { data: spend } = await admin
    .from('meta_daily_spend')
    .select('spend')
    .in('ad_account_id', (accts ?? []).map((a) => a.id))
    .eq('currency', 'USD')
    .gte('spend_date', from)
    .lte('spend_date', to)
  const next = new Date(`${to}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  const { data: rows } = await admin
    .from('ledger_entries')
    .select('type, usd_amount, debit_bdt, credit_bdt')
    .eq('organization_id', orgA)
    .gte('created_at', dhakaStart(from))
    .lt('created_at', dhakaStart(next.toISOString().slice(0, 10)))
  const sum = (type: string, k: 'usd_amount' | 'debit_bdt' | 'credit_bdt') =>
    (rows ?? []).filter((r) => r.type === type).reduce((s, r) => s + Number(r[k] ?? 0), 0)
  return {
    spend: (spend ?? []).reduce((s, r) => s + Number(r.spend), 0),
    approved: sum('LIMIT_APPROVAL', 'usd_amount'),
    billed: sum('LIMIT_APPROVAL', 'debit_bdt'),
    paid: sum('PAYMENT', 'credit_bdt'),
  }
}

test.beforeAll(async () => {
  const admin = adminClient(loadE2EEnv())
  const f = fixtures()
  const { data: acct, error } = await admin
    .from('ad_accounts')
    .insert({ name: `ZZ E2E spend ${f.run}`, platform: 'META', status: 'ACTIVE', organization_id: f.orgA, is_platform: false, external_account_id: `act_e2e_${f.run}_${Date.now()}`, meta_currency: 'USD' })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  // Fetched two minutes ago, so Refresh isn't throttled.
  const fetchedAt = new Date(Date.now() - 2 * 60_000).toISOString()
  const { error: sErr } = await admin.from('meta_daily_spend').upsert([
    { ad_account_id: acct.id, spend_date: dhakaToday(), spend: 12.34, currency: 'USD', fetched_at: fetchedAt },
    { ad_account_id: acct.id, spend_date: dhakaYesterday(), spend: 3.21, currency: 'USD', fetched_at: fetchedAt },
  ])
  if (sErr) throw new Error(sErr.message)
  const now = new Date().toISOString()
  const { error: lErr } = await admin.from('ledger_entries').insert([
    { client_id: f.clientA, organization_id: f.orgA, type: 'LIMIT_APPROVAL', reference_type: 'LIMIT_REQUEST', usd_amount: 50, debit_bdt: 6500, credit_bdt: 0, created_at: now, description: 'e2e dashboard' },
    { client_id: f.clientA, organization_id: f.orgA, type: 'PAYMENT', reference_type: 'PAYMENT', debit_bdt: 0, credit_bdt: 3000, created_at: now, description: 'e2e dashboard' },
  ])
  if (lErr) throw new Error(lErr.message)
})

test('spent, approved and paid by period, day by day', async ({ page }) => {
  const errors: Array<string> = []
  const THIRD_PARTY = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => {
    if (!THIRD_PARTY.test(r.url())) errors.push(`requestfailed: ${r.url()}`)
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource: net::/.test(m.text())) errors.push(`console: ${m.text()}`)
  })

  await page.goto('/agency')
  await page.waitForLoadState('networkidle')
  const card = (label: string) => page.locator('[data-slot="card"]').filter({ hasText: label }).first()
  const periods = page.getByRole('group', { name: 'Period' })

  // Today (the default).
  const today = dhakaToday()
  const t = await expected(today, today)
  expect(t.spend, 'seeded spend').toBeGreaterThanOrEqual(12.34)
  await expect(periods.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true')
  await expect(card('USD spent')).toContainText(usd(t.spend))
  await expect(card('Limit approved')).toContainText(usd(t.approved))
  await expect(card('Limit approved')).toContainText(`Billed ${bdt(t.billed)}`)
  await expect(card('Paid by clients')).toContainText(bdt(t.paid))
  await expect(page.getByText(/Meta spend as of/)).toBeVisible()

  // Yesterday: one day, so cards only — no day-by-day table.
  const yesterday = dhakaYesterday()
  const y = await expected(yesterday, yesterday)
  expect(y.spend, 'seeded spend').toBeGreaterThanOrEqual(3.21)
  await periods.getByRole('button', { name: 'Yesterday' }).click()
  await expect(periods.getByRole('button', { name: 'Yesterday' })).toHaveAttribute('aria-pressed', 'true')
  await expect(card('USD spent').getByText(usd(y.spend), { exact: true })).toBeVisible()
  await expect(card('Limit approved')).toContainText(usd(y.approved))
  await expect(card('Paid by clients')).toContainText(bdt(y.paid))
  await expect(page.getByRole('columnheader', { name: 'Day' })).toHaveCount(0)

  // This month, and its row for today.
  const m = await expected(`${today.slice(0, 8)}01`, today)
  await periods.getByRole('button', { name: 'This month' }).click()
  await expect(card('USD spent')).toContainText(usd(m.spend))
  const todayLabel = new Date(`${today}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  const row = page.getByRole('row').filter({ hasText: todayLabel })
  await expect(row).toContainText(usd(t.spend))
  await expect(row).toContainText(usd(t.approved))
  await expect(row).toContainText(bdt(t.paid))

  // Last month.
  const first = new Date(`${today.slice(0, 8)}01T00:00:00Z`)
  const lastDay = new Date(first.getTime() - 86_400_000).toISOString().slice(0, 10)
  const l = await expected(`${lastDay.slice(0, 8)}01`, lastDay)
  await periods.getByRole('button', { name: 'Last month' }).click()
  await expect(card('USD spent')).toContainText(usd(l.spend))

  // Refresh: e2e's Meta token is inert, so it reports that and keeps the figures.
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText(/Meta could not be reached/)).toBeVisible()

  await periods.getByRole('button', { name: 'This week' }).click()
  await page.getByRole('button', { name: /Switch to dark mode/ }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/agency-dashboard-period-dark.png', fullPage: true })
  await page.getByRole('button', { name: /Switch to light mode/ }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'horizontal page scroll at 390px').toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})
