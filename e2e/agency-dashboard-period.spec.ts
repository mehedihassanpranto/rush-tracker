import { expect, test } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient } from './support/seed'

/**
 * Agency dashboard period filter (migration 000067): USD spent (Meta's daily
 * spend, cached), limit approved and paid by clients — Today, then This month
 * with its day-by-day table. Seeds org A's own data; global teardown deletes
 * org A's ledger and ad accounts (and so the cached spend with them).
 */
test.use(auth('agencyA'))

const dhakaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

test.beforeAll(async () => {
  const admin = adminClient(loadE2EEnv())
  const f = fixtures()
  const { data: acct, error } = await admin
    .from('ad_accounts')
    .insert({ name: `ZZ E2E spend ${f.run}`, platform: 'META', status: 'ACTIVE', organization_id: f.orgA, is_platform: false, external_account_id: `act_e2e_${f.run}`, meta_currency: 'USD' })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  // Fetched two minutes ago, so Refresh isn't throttled.
  const fetchedAt = new Date(Date.now() - 2 * 60_000).toISOString()
  const { error: sErr } = await admin.from('meta_daily_spend').upsert({
    ad_account_id: acct.id, spend_date: dhakaToday(), spend: 12.34, currency: 'USD', fetched_at: fetchedAt,
  })
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
  await expect(periods.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true')
  await expect(card('USD spent')).toContainText('$12.34')
  await expect(card('Limit approved')).toContainText('$50.00')
  await expect(card('Limit approved')).toContainText('Billed ৳6,500')
  await expect(card('Paid by clients')).toContainText('৳3,000')
  await expect(page.getByText(/Meta spend as of/)).toBeVisible()

  // This month: same totals so far, and a row for today.
  await periods.getByRole('button', { name: 'This month' }).click()
  await expect(card('USD spent')).toContainText('$12.34')
  const today = new Date(`${dhakaToday()}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  const row = page.getByRole('row').filter({ hasText: today })
  await expect(row).toContainText('$12.34')
  await expect(row).toContainText('$50.00')
  await expect(row).toContainText('৳3,000')

  // Last month: nothing seeded there.
  await periods.getByRole('button', { name: 'Last month' }).click()
  await expect(card('USD spent')).toContainText('$0.00')

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
