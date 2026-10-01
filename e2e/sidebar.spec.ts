import { expect, test } from '@playwright/test'
import { auth } from './support/fixtures'

/**
 * Every sidebar link of each area must load under its own prefix without an
 * uncaught page error. Console noise from the (deliberately inert) Meta
 * integration is ignored; uncaught exceptions and the app's error boundary
 * are not.
 */
const AREAS: Array<[role: string, prefix: string]> = [
  ['platform', '/platform'],
  ['agencyA', '/agency'],
  ['client', '/client'],
]

for (const [role, prefix] of AREAS) {
  test.describe(`${role} sidebar`, () => {
    test.use(auth(role))

    test(`every link under ${prefix} loads cleanly`, async ({ page }) => {
      // One test walks ~15 pages and the dev server compiles each route on its
      // first visit, which is slow on a CI runner — budget per page, not 60s.
      test.setTimeout(5 * 60_000)
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(`${page.url()} — ${e.message}`))

      await page.goto(prefix)
      await page.waitForLoadState('networkidle')
      const hrefs = await page.locator('nav a[href]').evaluateAll((as) =>
        [...new Set(as.map((a) => a.getAttribute('href') ?? ''))],
      )
      const internal = hrefs.filter((h) => h.startsWith('/'))
      expect(internal.length, 'sidebar should have links').toBeGreaterThan(3)

      for (const href of internal) {
        await page.goto(href)
        await page.waitForLoadState('networkidle')
        expect(new URL(page.url()).pathname, `${href} stays in ${prefix}`).toMatch(new RegExp(`^${prefix}(/|$)`))
        await expect(page.getByText(/something went wrong|application error/i), `${href} error boundary`).toHaveCount(0)
      }
      expect(errors).toEqual([])
    })
  })
}
