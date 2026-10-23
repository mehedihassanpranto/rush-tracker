import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient, sessionCookies } from './support/seed'

/**
 * Agencies paying the platform (migration 000066), end to end:
 * a regular agency ADMIN never sees Platform Billing; the SUPER_ADMIN submits a
 * payment with proof; the platform approves it from Finance → Agencies; the
 * agency then sees it accepted and kept as credit. The booked payment is
 * reversed afterwards so staging's books stay clean.
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
const amount = `${Math.floor(Math.random() * 900) + 100}.45`

test('a regular agency admin does not see Platform Billing', async ({ browser }) => {
  const f = fixtures()
  const { cookies } = await sessionCookies(loadE2EEnv(), f.securityUsers.pwUser.email)
  const context = await browser.newContext()
  await context.addCookies(cookies)
  const page = await context.newPage()
  await page.goto('/agency')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('link', { name: 'Clients' }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Platform Billing' })).toHaveCount(0)
  await page.goto('/agency/platform-billing')
  await page.waitForLoadState('networkidle')
  expect(new URL(page.url()).pathname).toBe('/agency')
  await context.close()
})

test.describe('super admin submits', () => {
  test.use(auth('agencyA'))
  test('pays the platform with proof', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/agency')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: 'Platform Billing' }).click()
    await expect(page.getByRole('heading', { name: 'Platform Billing' })).toBeVisible()
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
    await expect(page.getByText(/agencies see this on their Platform Billing page/)).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('super admin sees the outcome', () => {
  test.use(auth('agencyA'))
  test('the payment is accepted and kept as credit', async ({ page }) => {
    await page.goto('/agency/platform-billing')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(`E2E: pay DBBL A/C 000 — ${fixtures().run}`)).toBeVisible()
    const row = page.getByRole('row').filter({ hasText: 'Accepted' }).first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('kept as credit')
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'test-results/agency-platform-billing-light.png', fullPage: true })
    await page.getByRole('button', { name: /Switch to dark mode/ }).click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'test-results/agency-platform-billing-dark.png', fullPage: true })
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
})
