import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient, sessionCookies } from './support/seed'

/**
 * An agency's Finance (2026-10-23), end to end: a regular agency ADMIN never
 * sees it (Finance or the old Platform Billing address); the SUPER_ADMIN sees
 * the margin on a limit approved on a platform pool account (client ৳130 vs
 * platform ৳125 on $100 = ৳500), submits a payment to the platform with
 * proof; the platform approves it from Finance → Agencies; the agency then sees
 * it accepted as credit. Everything booked is reversed afterwards.
 */
test.describe.configure({ mode: 'serial' })

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

function watchErrors(page: Page): Array<string> {
  const errors: Array<string> = []
  const THIRD_PARTY = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => {
    if (!THIRD_PARTY.test(r.url())) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`)
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource: net::/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  return errors
}

// Paise on purpose: taka is shown without a trailing .00, so "969.00" would
// display as ৳969 and never match.
let poolAccount = ''
let requestId = ''

test.beforeAll(async () => {
  const admin = adminClient(loadE2EEnv())
  const f = fixtures()
  const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const { error: rateErr } = await admin.rpc('set_agency_rate', { p_actor: null, p_org: f.orgA, p_rate: 125, p_from: yesterday, p_note: 'e2e' })
  if (rateErr && !/DUPLICATE/.test(rateErr.message)) throw new Error(rateErr.message)
  const { data: acct, error } = await admin
    .from('ad_accounts')
    .insert({ name: `ZZ E2E pool ${f.run}`, platform: 'META', status: 'ACTIVE', is_platform: true, organization_id: null, usd_rate: 0 })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  poolAccount = acct.id
  await admin.from('platform_account_grants').insert({ ad_account_id: poolAccount, organization_id: f.orgA })
  const { data: asg } = await admin
    .from('ad_account_assignments')
    .insert({ ad_account_id: poolAccount, client_id: f.clientA, opening_limit_usd: 0, organization_id: f.orgA })
    .select('id')
    .single()
  const { data: lr, error: lrErr } = await admin
    .from('limit_requests')
    .insert({
      client_id: f.clientA, ad_account_id: poolAccount, organization_id: f.orgA, assignment_id: asg!.id,
      opening_balance_usd: 0, requested_amount_usd: 100, default_usd_rate: 130, expected_new_limit_usd: 100,
      status: 'PENDING', segment: 'postpaid', total_cost_bdt: 13000,
    })
    .select('id')
    .single()
  if (lrErr) throw new Error(lrErr.message)
  requestId = lr.id
  // Approve: the billing trigger charges org A at its ৳125 rate.
  const { error: apErr } = await admin
    .from('limit_requests')
    .update({ status: 'APPROVED', approved_amount_usd: 100, approved_usd_rate: 130, bdt_charge: 13000, approved_at: new Date().toISOString() })
    .eq('id', requestId)
  if (apErr) throw new Error(apErr.message)
})

const amount = `${Math.floor(Math.random() * 900) + 100}.45`

test('a regular agency admin does not see Finance', async ({ browser }) => {
  const f = fixtures()
  const { cookies } = await sessionCookies(loadE2EEnv(), f.securityUsers.pwUser.email)
  const context = await browser.newContext()
  await context.addCookies(cookies)
  const page = await context.newPage()
  await page.goto('/agency')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('link', { name: 'Clients' }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Finance' })).toHaveCount(0)
  for (const path of ['/agency/finance', '/agency/platform-billing']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    expect(new URL(page.url()).pathname, path).toBe('/agency')
  }
  await context.close()
})

test.describe('super admin submits', () => {
  test.use(auth('agencyA'))
  test('sees the margin on a platform account approval', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/agency')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: 'Finance' }).click()
    await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible()
    const card = (label: string) => page.locator('[data-slot="card"]').filter({ hasText: label }).first()
    await expect(card('Billed to clients')).toContainText('৳13,000')
    await expect(card('Owed to the platform')).toContainText('৳12,500')
    await expect(card('Your margin')).toContainText('৳500')
    await expect(card('Your margin')).toContainText('৳5.00 per USD')
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'test-results/agency-finance-overview-light.png', fullPage: true })
    await page.getByRole('button', { name: /Switch to dark mode/ }).click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'test-results/agency-finance-overview-dark.png', fullPage: true })
    await page.getByRole('button', { name: /Switch to light mode/ }).click()

    await page.getByRole('tab', { name: 'Margin by approval' }).click()
    const row = page.getByRole('row').filter({ hasText: 'Billed by platform' }).first()
    await expect(row).toContainText('৳13,000')
    await expect(row).toContainText('৳12,500')
    await expect(row).toContainText('৳500')
    await page.setViewportSize({ width: 390, height: 844 })
    for (const t of ['Overview', 'Margin by approval']) {
      await page.getByRole('tab', { name: t }).click()
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(o, `${t}: horizontal page scroll at 390px`).toBeLessThanOrEqual(0)
    }
    expect(errors).toEqual([])
  })

  test('pays the platform with proof', async ({ page }) => {
    const errors = watchErrors(page)
    // The old address still lands on the right tab.
    await page.goto('/agency/platform-billing')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('tab', { name: 'Pay the platform' })).toHaveAttribute('data-state', 'active')
    await expect(page.getByText('How to pay')).toBeVisible()

    await page.getByRole('button', { name: 'Pay the platform' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Amount (BDT)').fill(amount)
    await dialog.getByLabel('Paid by').fill('DBBL transfer')
    await dialog.getByLabel('Transaction ID (optional)').fill(`E2E-${Date.now()}`)
    // Submit stays disabled until the proof is attached.
    await expect(dialog.getByRole('button', { name: 'Submit payment' })).toBeDisabled()
    await dialog.getByLabel('Proof file').setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: PNG })
    await expect(dialog.getByText('proof.png')).toBeVisible()
    await dialog.getByRole('button', { name: 'Submit payment' }).click()
    await expect(page.getByText(/Sent for review \(APS-/)).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: 'Under review' }).first()).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, 'horizontal page scroll at 390px').toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })
})

test.describe('platform approves', () => {
  test.use(auth('platform'))
  test('reviews the payment in Finance → Agencies', async ({ page }) => {
    const errors = watchErrors(page)
    const f = fixtures()
    await page.goto('/platform/finance')
    await page.waitForLoadState('networkidle')
    await page.getByRole('tab', { name: 'Agencies' }).click()
    await expect(page.getByRole('heading', { name: /Payments to review/ })).toBeVisible()
    // The review row: this agency, this amount, and an Approve button (the
    // Agencies table's own row for the agency shows the amount once it's paid).
    const row = page
      .getByRole('row')
      .filter({ hasText: `ZZ E2E Agency A ${f.run}` })
      .filter({ hasText: amount })
      .filter({ has: page.getByRole('button', { name: 'Approve' }) })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Approve' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Amount that arrived (BDT)')).toHaveValue(amount)
    await dialog.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByText(/^Approved/)).toBeVisible()
    await expect(row).toHaveCount(0)

    // Where agencies should pay: saved here, shown on their billing page.
    await page.goto('/platform/settings')
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Payment details shown to agencies').fill(`E2E: pay DBBL A/C 000 — ${f.run}`)
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.getByText(/agencies see this under Finance → Pay the platform/)).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('super admin sees the outcome', () => {
  test.use(auth('agencyA'))
  test('the payment is accepted and settles what the agency owed', async ({ page }) => {
    await page.goto('/agency/finance?tab=platform')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(`E2E: pay DBBL A/C 000 — ${fixtures().run}`)).toBeVisible()
    const row = page.getByRole('row').filter({ hasText: 'Accepted' }).first()
    await expect(row).toBeVisible()
    // Org A owed ৳12,500 for the $100 approval, so the whole payment settles
    // part of that (nothing left over as credit) and "You owe" drops by it.
    const owed = (12500 - Number(amount)).toLocaleString('en-US', { maximumFractionDigits: 2 })
    await expect(page.locator('[data-slot="card"]').filter({ hasText: 'You owe' }).first()).toContainText(`৳${owed}`)
    await expect(row).not.toContainText('kept as credit')
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'test-results/agency-finance-pay-light.png', fullPage: true })
    await page.getByRole('button', { name: /Switch to dark mode/ }).click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'test-results/agency-finance-pay-dark.png', fullPage: true })
    await page.getByRole('button', { name: /Switch to light mode/ }).click()
  })
})

test.afterAll(async () => {
  // Reverse what this run booked; the agency (and its submissions) is deleted
  // by global teardown.
  const admin = adminClient(loadE2EEnv())
  const f = fixtures()
  const { data } = await admin.from('agency_payments').select('id').eq('organization_id', f.orgA).eq('status', 'POSTED')
  for (const p of data ?? []) {
    await admin.rpc('reverse_agency_payment', { p_actor: null, p_id: p.id, p_reason: 'e2e cleanup' })
  }
  await admin.from('platform_settings').delete().eq('key', 'agency_payment_instructions')
  const { data: charges } = await admin.from('agency_charges').select('id').eq('organization_id', f.orgA).neq('status', 'REVERSED')
  for (const c of charges ?? []) {
    await admin.rpc('reverse_agency_charge', { p_actor: null, p_id: c.id, p_reason: 'e2e cleanup' })
  }
  if (requestId) await admin.from('limit_requests').delete().eq('id', requestId)
  if (poolAccount) {
    await admin.from('ad_account_assignments').delete().eq('ad_account_id', poolAccount)
    await admin.from('platform_account_grants').delete().eq('ad_account_id', poolAccount)
    await admin.from('ad_accounts').delete().eq('id', poolAccount)
  }
})
