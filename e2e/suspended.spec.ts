import { expect, test } from '@playwright/test'
import { auth } from './support/fixtures'

test.describe('suspended agency', () => {
  test.use(auth('suspended'))

  for (const area of ['/agency', '/client']) {
    test(`${area} redirects to the suspended page`, async ({ page }) => {
      await page.goto(area)
      await expect(page).toHaveURL(/\/subscription-suspended/)
      await expect(page.getByText(/subscription inactive/i)).toBeVisible()
    })
  }
})
