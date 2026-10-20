import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { auth } from './support/fixtures'

/**
 * Platform Finance v2 (migration 000059) through the real UI: a supplier with
 * a receiving bank, a Binance purchase whose fees the dialog works out from
 * the rules, a USD payout drawn FIFO, the fee rules list — then the payout and
 * the batch are reversed, so staging's inventory ends where it started.
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
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
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
  await dialog.getByLabel('BDT paid to supplier').fill('125998.74')
  await expect(dialog.getByText('Binance transfer')).toBeVisible()
  await expect(dialog.getByText(/Dutch-Bangla Bank → Dutch-Bangla Bank/)).toBeVisible()
  await expect(dialog.locator('dd').filter({ hasText: '$999.99' })).toBeVisible()
  await expect(dialog.locator('dd').filter({ hasText: '৳126,000' })).toBeVisible()
  await expect(dialog.locator('dd').filter({ hasText: '৳1.26' })).toBeVisible()
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
