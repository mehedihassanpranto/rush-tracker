import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { auth } from './support/fixtures'

/**
 * Platform Finance v2 (migration 000059) through the real UI: a supplier with
 * a receiving bank, a Binance purchase whose fees the dialog works out from
 * the rules, a USD payout drawn FIFO, the journal and trial balance, the fee
 * rules list — the payout and the batch are reversed, so staging's inventory
 * ends where it started.
 *
 * Screenshots (light, dark, phone) go to test-results/ for review; the
 * assertions are what CI checks, including no horizontal scroll at phone
 * width and zero page/console errors.
 */
test.use(auth('platform'))

/** Flip the theme the way a user does, then let colour transitions finish
 * so the screenshot shows the settled theme. */
async function setTheme(page: Page, theme: 'light' | 'dark') {
  const current = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  if ((current === 'dark') !== (theme === 'dark')) {
    await page.getByRole('button', { name: /Switch to (dark|light) mode/ }).click()
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await page.waitForTimeout(600)
}

async function choose(page: Page, label: string | RegExp, option: string | RegExp) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option }).click()
}

test('fee-aware purchase, FIFO payout and reversals', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  const errors: Array<string> = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  // A failed app or Supabase request fails the test; the Google Fonts
  // stylesheet is third-party and its outages are not ours. The browser's
  // matching "Failed to load resource: net::…" console line carries no URL,
  // so network failures are judged here, by URL, and skipped in the console
  // check. An HTTP error status (a 500) still fails it.
  const THIRD_PARTY = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//
  page.on('requestfailed', (r) => {
    if (!THIRD_PARTY.test(r.url())) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`)
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource: net::/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  const stamp = Date.now()
  const name = `E2E-V2-${stamp}`

  await page.goto('/platform/finance')
  // Clicks before hydration focus a tab without switching it.
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: 'Finance & Accounts' })).toBeVisible()

  // Supplier with its receiving bank.
  await page.getByRole('tab', { name: 'Source Summary' }).click()
  await page.getByRole('button', { name: 'New source' }).click()
  await page.getByLabel('Name').fill(name)
  await choose(page, 'Payment method (USD)', 'Binance')
  await choose(page, 'Receiving bank', 'Dutch-Bangla Bank')
  await page.getByRole('button', { name: 'Add source' }).click()
  await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Dutch-Bangla Bank')

  // Purchase: the preview must show the golden B1 figures before posting.
  await page.getByRole('button', { name: 'Add USD purchase' }).click()
  const dialog = page.getByRole('dialog')
  await choose(page, 'Source', new RegExp(name))
  await dialog.getByLabel('USD sent').fill('1000')
  await dialog.getByLabel('BDT paid to supplier').fill('126000')
  await expect(dialog.getByText('Binance transfer')).toBeVisible()
  await expect(dialog.getByText(/Dutch-Bangla Bank → Dutch-Bangla Bank/)).toBeVisible()
  await expect(dialog.locator('dd').filter({ hasText: '$999.99' })).toBeVisible()
  await expect(dialog.locator('dd').filter({ hasText: '৳126,000' })).toBeVisible()
  await expect(dialog.locator('dd').filter({ hasText: '৳126.0000' })).toBeVisible()
  await page.screenshot({ path: 'test-results/finance-purchase-light.png', fullPage: true })
  await dialog.getByRole('button', { name: 'Record purchase' }).click()
  await expect(dialog).toBeHidden()

  // Inventory: the batch, then a payout drawn from stock.
  await page.getByRole('tab', { name: 'Inventory (FIFO)' }).click()
  const batch = page.getByRole('row', { name: new RegExp(name) })
  await expect(batch).toContainText('$999.99')
  await expect(batch).toContainText('৳126,000')

  await page.getByRole('button', { name: 'Record USD paid out' }).click()
  await choose(page, 'What was it', 'Something else')
  await page.getByRole('dialog').getByLabel('USD paid').fill('1')
  await page.getByRole('dialog').getByLabel('What was it for').fill(`e2e payout ${stamp}`)
  await page.getByRole('dialog').getByRole('button', { name: 'Record' }).click()
  await expect(page.getByText(/Recorded — FIFO cost/)).toBeVisible()
  const payout = page.getByRole('row', { name: new RegExp(`e2e payout ${stamp}`) })
  await expect(payout).toContainText('$1.00')

  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/finance-inventory-light.png', fullPage: true })
  await setTheme(page, 'dark')
  await page.screenshot({ path: 'test-results/finance-inventory-dark.png', fullPage: true })
  await setTheme(page, 'light')

  // Phone width: no sideways page scroll (tables scroll inside their card).
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/finance-inventory-phone.png', fullPage: true })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'horizontal page scroll at 390px').toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1280, height: 900 })

  // Clean up through the UI: payout first, then the now-unused batch.
  await payout.getByRole('button', { name: 'Reverse' }).click()
  await page.getByLabel('Reason').fill('e2e cleanup')
  await page.getByRole('dialog').getByRole('button', { name: 'Reverse' }).click()
  await expect(payout).toContainText('Reversed')
  await batch.getByRole('button', { name: 'Reverse' }).click()
  await page.getByLabel('Reason').fill('e2e cleanup')
  await page.getByRole('dialog').getByRole('button', { name: 'Reverse' }).click()
  await expect(batch).toContainText('Reversed')

  // Journal (000061): the purchase and both reversals are posted, the trial
  // balance balances, and the books tie to the FIFO stock.
  await page.getByRole('tab', { name: 'Journal' }).click()
  await expect(page.getByText('The books agree with the USD stock')).toBeVisible()
  await expect(page.getByText('· balanced')).toBeVisible()
  await expect(page.getByText(new RegExp(`from ${name}`)).first()).toBeVisible()
  await expect(page.getByText(/Reversal of JE-/).first()).toBeVisible()
  await setTheme(page, 'dark')
  await page.screenshot({ path: 'test-results/finance-journal-dark.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const journalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(journalOverflow, 'journal: horizontal page scroll at 390px').toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1280, height: 900 })
  await setTheme(page, 'light')

  // Meta Accounts (000063): the pool table and the daily reading run by hand.
  // e2e's Meta token is inert, so accounts can't be read — the job must still
  // finish and say so rather than fail.
  await page.getByRole('tab', { name: 'Meta Accounts' }).click()
  await expect(page.getByRole('heading', { name: 'Pool accounts' })).toBeVisible()
  await page.getByRole('button', { name: 'Read spend now' }).click()
  await expect(page.getByText(/^Read \d+ accounts? from Meta/)).toBeVisible()
  await setTheme(page, 'dark')
  await page.screenshot({ path: 'test-results/finance-meta-dark.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const metaOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(metaOverflow, 'meta accounts: horizontal page scroll at 390px').toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1280, height: 900 })
  await setTheme(page, 'light')

  // Agencies (000064): the billing table and the payment dialog's preview of
  // how a payment splits into "settles what's owed" and "advance". Cancelled:
  // payments are immutable, so e2e doesn't create one every run.
  await page.getByRole('tab', { name: 'Agencies' }).click()
  await expect(page.getByRole('heading', { name: 'Agencies' })).toBeVisible()
  await page.getByRole('button', { name: 'Record agency payment' }).click()
  const payDialog = page.getByRole('dialog')
  await page.getByRole('combobox', { name: 'Agency', exact: true }).click()
  await page.getByRole('option').first().click()
  await payDialog.getByLabel('BDT received').fill('1000000')
  await expect(payDialog.getByText(/settles what is owed;/)).toBeVisible()
  await payDialog.getByRole('button', { name: 'Cancel' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const agencyOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(agencyOverflow, 'agencies: horizontal page scroll at 390px').toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('tab', { name: 'Journal' }).click()
  await expect(page.getByRole('heading', { name: 'Months' })).toBeVisible()
  await setTheme(page, 'dark')
  await page.screenshot({ path: 'test-results/finance-months-dark.png' })
  await setTheme(page, 'light')

  // Fee rules: the owner's three seeded rules.
  await page.getByRole('tab', { name: 'Fee Rules' }).click()
  for (const code of ['dbbl-internal', 'npsb-flat', 'binance-transfer']) {
    await expect(page.getByRole('cell', { name: new RegExp(code) })).toBeVisible()
  }
  await setTheme(page, 'dark')
  await page.screenshot({ path: 'test-results/finance-fees-dark.png', fullPage: true })

  // Leave the supplier deactivated.
  await page.getByRole('tab', { name: 'Source Summary' }).click()
  await page.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: 'Deactivate' }).click()

  await setTheme(page, 'light')
  expect(errors).toEqual([])
})
