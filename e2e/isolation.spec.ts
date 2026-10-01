import { expect, test } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'

// Agency A's admin must see A's data and none of B's — through the list
// screens and through a direct by-id URL.
test.describe('agency A', () => {
  test.use(auth('agencyA'))

  test('sees its own client and not agency B’s', async ({ page }) => {
    const f = fixtures()
    await page.goto('/agency/clients')
    await expect(page.getByText(f.clientAName)).toBeVisible()
    await expect(page.getByText(f.clientBName)).toHaveCount(0)
  })

  test('sees its own ad account and not agency B’s', async ({ page }) => {
    const f = fixtures()
    await page.goto('/agency/ad-accounts')
    await expect(page.getByText(f.accountAName)).toBeVisible()
    await expect(page.getByText(f.accountBName)).toHaveCount(0)
  })

  test('cannot open agency B’s client by id', async ({ page }) => {
    const f = fixtures()
    await page.goto(`/agency/clients/${f.clientB}`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(f.clientBName)).toHaveCount(0)
  })
})

test.describe('agency B', () => {
  test.use(auth('agencyB'))

  test('sees its own data and not agency A’s', async ({ page }) => {
    const f = fixtures()
    await page.goto('/agency/clients')
    await expect(page.getByText(f.clientBName)).toBeVisible()
    await expect(page.getByText(f.clientAName)).toHaveCount(0)
    await page.goto('/agency/ad-accounts')
    await expect(page.getByText(f.accountBName)).toBeVisible()
    await expect(page.getByText(f.accountAName)).toHaveCount(0)
  })
})
