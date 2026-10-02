import { expect, test } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'

// Order matters: the platform puts agency A on a plan and records a payment,
// then agency A sees it. Everything runs on the throwaway agency seeded for
// this run, and is removed with it at teardown.
test.describe.configure({ mode: 'serial' })

test.describe('subscription plans — platform', () => {
  test.use(auth('platform'))

  test('Plans page lists the starting plans', async ({ page }) => {
    await page.goto('/platform/plans')
    for (const name of ['Basic', 'Standard', 'Advance', 'Unlimited']) {
      // .first(): "Unlimited" is also the text of that plan's limit cells.
      await expect(page.getByRole('cell', { name, exact: true }).first()).toBeVisible()
    }
  })

  test('a new agency starts with no plan and no payments', async ({ page }) => {
    const f = fixtures()
    await page.goto(`/platform/organizations/${f.orgA}`)
    await expect(page.getByText('Plan & billing')).toBeVisible()
    await expect(page.getByText('No plan (no limits)')).toBeVisible()
    await expect(page.getByText('No payments recorded yet.')).toBeVisible()
  })

  test('change the plan, then record a payment', async ({ page }) => {
    const f = fixtures()
    await page.goto(`/platform/organizations/${f.orgA}`)

    await page.getByRole('button', { name: 'Change plan' }).click()
    const planDialog = page.getByRole('dialog')
    await planDialog.getByRole('combobox').click()
    await page.getByRole('option', { name: /^Basic/ }).click()
    await planDialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Plan updated')).toBeVisible()
    await expect(page.getByText('No payment yet')).toBeVisible()

    await page.getByRole('button', { name: 'Record payment' }).click()
    const payDialog = page.getByRole('dialog')
    // Prefilled from the plan's fee.
    await expect(payDialog.getByLabel('Amount (BDT)')).toHaveValue('1500')
    await payDialog.getByRole('button', { name: 'Record payment' }).click()
    await expect(page.getByText('Payment recorded')).toBeVisible()
    await expect(page.getByText('Paid', { exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '৳1,500', exact: true })).toBeVisible()
  })
})

test.describe('subscription plans — agency', () => {
  test.use(auth('agencyA'))

  test('Settings shows the agency its own plan and usage, read-only', async ({ page }) => {
    await page.goto('/agency/settings')
    await expect(page.getByText('Your plan')).toBeVisible()
    await expect(page.getByText(/^Basic — ৳1,500/)).toBeVisible()
    await expect(page.getByText('Paid', { exact: true })).toBeVisible()
    // 1 active client of 5 (seeded); no plan controls for the agency.
    await expect(page.getByText('1 / 5')).toBeVisible()
    await expect(page.getByRole('button', { name: /change plan|record payment/i })).toHaveCount(0)
  })
})
