import { expect, test } from '@playwright/test'
import { auth } from './support/fixtures'

const AREAS = ['/platform', '/agency', '/client'] as const

const HOME: Record<string, (typeof AREAS)[number]> = {
  platform: '/platform',
  agencyA: '/agency',
  client: '/client',
}

for (const [role, home] of Object.entries(HOME)) {
  test.describe(`${role} is kept inside ${home}`, () => {
    test.use(auth(role))

    for (const area of AREAS) {
      test(`visiting ${area} ends up under ${home}`, async ({ page }) => {
        await page.goto(area)
        await expect(page).toHaveURL(new RegExp(`${home}(/|$)`))
      })
    }
  })
}

test.describe('signed out', () => {
  for (const area of AREAS) {
    test(`${area} requires login`, async ({ page }) => {
      await page.goto(area)
      await expect(page).toHaveURL(/\/login/)
    })
  }
})
