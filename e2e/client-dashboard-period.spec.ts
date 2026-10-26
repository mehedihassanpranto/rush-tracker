import { expect, test } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient } from './support/seed'

/**
 * Client dashboard period filter (2026-10-23): a client sees spend only on
 * accounts while they were assigned to IT — $100 spent the day before the
 * assignment is not theirs, $7.50 spent after is — plus its own approvals and
 * payments by Dhaka day. Org A's ad accounts and ledger are removed by global
 * teardown.
 */
test.use(auth('client'))

const dhakaDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
const bdt = (n: number) => `৳${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

test.beforeAll(async () => {
  const admin = adminClient(loadE2EEnv())
  const f = fixtures()
  // Find-or-create, so a retry reuses the account rather than doubling its spend.
  const name = `ZZ E2E client spend ${f.run}`
  let { data: acct } = await admin.from('ad_accounts').select('id').eq('name', name).maybeSingle()
  if (!acct) {
    const { data, error } = await admin
      .from('ad_accounts')
      .insert({ name, platform: 'META', status: 'ACTIVE', organization_id: f.orgA, is_platform: false, external_account_id: `act_e2ec_${f.run}`, meta_currency: 'USD' })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    acct = data
    // Assigned to client A from the start of today (Dhaka).
    const { error: aErr } = await admin.from('ad_account_assignments').insert({
      ad_account_id: acct.id, client_id: f.clientA, opening_limit_usd: 0, organization_id: f.orgA,
      assigned_at: new Date(`${dhakaDate()}T00:00:00+06:00`).toISOString(),
    })
    if (aErr) throw new Error(aErr.message)
  }
  const fetchedAt = new Date(Date.now() - 2 * 60_000).toISOString()
  const { error: sErr } = await admin.from('meta_daily_spend').upsert([
    { ad_account_id: acct.id, spend_date: dhakaDate(-1), spend: 100, currency: 'USD', fetched_at: fetchedAt },
    { ad_account_id: acct.id, spend_date: dhakaDate(), spend: 7.5, currency: 'USD', fetched_at: fetchedAt },
  ])
  if (sErr) throw new Error(sErr.message)
  const now = new Date().toISOString()
  await admin.from('ledger_entries').insert([
    { client_id: f.clientA, organization_id: f.orgA, type: 'LIMIT_APPROVAL', reference_type: 'LIMIT_REQUEST', usd_amount: 20, debit_bdt: 2600, credit_bdt: 0, created_at: now, description: 'e2e client dashboard' },
    { client_id: f.clientA, organization_id: f.orgA, type: 'PAYMENT', reference_type: 'PAYMENT', debit_bdt: 0, credit_bdt: 1000, created_at: now, description: 'e2e client dashboard' },
  ])
})

test('a client sees its own spend, approvals and payments by period', async ({ page }) => {
  const errors: Array<string> = []
  const THIRD_PARTY = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => {
    if (!THIRD_PARTY.test(r.url())) errors.push(`requestfailed: ${r.url()}`)
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource: net::/.test(m.text())) errors.push(`console: ${m.text()}`)
  })

  // What the ledger holds for client A today (other specs add to it too).
  const admin = adminClient(loadE2EEnv())
  const { data: rows } = await admin
    .from('ledger_entries')
    .select('type, usd_amount, debit_bdt, credit_bdt')
    .eq('client_id', fixtures().clientA)
    .gte('created_at', new Date(`${dhakaDate()}T00:00:00+06:00`).toISOString())
  const sum = (type: string, k: 'usd_amount' | 'debit_bdt' | 'credit_bdt') =>
    (rows ?? []).filter((r) => r.type === type).reduce((s, r) => s + Number(r[k] ?? 0), 0)

  await page.goto('/client')
  await page.waitForLoadState('networkidle')
  const card = (label: string) => page.locator('[data-slot="card"]').filter({ hasText: label }).first()
  const periods = page.getByRole('group', { name: 'Period' })

  await expect(card('USD spent').getByText('$7.50', { exact: true })).toBeVisible()
  await expect(card('Limit approved')).toContainText(usd(sum('LIMIT_APPROVAL', 'usd_amount')))
  await expect(card('Limit approved')).toContainText(`Billed ${bdt(sum('LIMIT_APPROVAL', 'debit_bdt'))}`)
  await expect(card('You paid')).toContainText(bdt(sum('PAYMENT', 'credit_bdt')))

  // The $100 from the day before the account was this client's never counts:
  // yesterday is $0, today's $7.50 is all of this week and this month, and
  // last month is $0.
  const spent = card('USD spent')
  await periods.getByRole('button', { name: 'Yesterday' }).click()
  await expect(spent.getByText('$0.00', { exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Day' })).toHaveCount(0)
  for (const [p, value] of [['This week', '$7.50'], ['This month', '$7.50'], ['Last month', '$0.00']]) {
    await periods.getByRole('button', { name: p }).click()
    await expect(spent.getByText(value, { exact: true }), p).toBeVisible()
  }
  await expect(page.getByRole('row').filter({ hasText: '$100.00' })).toHaveCount(0)

  // Refresh asks Meta about the client's current account; e2e's token is inert.
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText(/Meta could not be reached/)).toBeVisible()

  await periods.getByRole('button', { name: 'This week' }).click()
  await expect(spent.getByText('$7.50', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/client-dashboard-period-light.png', fullPage: true })
  await page.getByRole('button', { name: /Switch to dark mode/ }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/client-dashboard-period-dark.png', fullPage: true })
  await page.getByRole('button', { name: /Switch to light mode/ }).click()
  await page.waitForTimeout(600)
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'horizontal page scroll at 390px').toBeLessThanOrEqual(0)
  await page.screenshot({ path: 'test-results/client-dashboard-period-phone.png', fullPage: true })
  expect(errors).toEqual([])
})
