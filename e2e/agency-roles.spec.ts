import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { PASSWORD, adminClient, sessionCookies } from './support/seed'

/**
 * Agency roles (2026-11-28): a Super Admin builds a role, gives a new staff
 * login that role, and the login then sees and can do only what the role
 * allows — in the menu, on the pages, and at the server. The staff login is
 * removed in afterAll; the role goes with agency A at global teardown.
 */

let roleName = ''
let staffEmail = ''
let paymentsCall: { url: string; headers: Record<string, string> } | null = null

function watchErrors(page: Page) {
  const errors: Array<string> = []
  const THIRD_PARTY = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => {
    if (!THIRD_PARTY.test(r.url())) errors.push(`requestfailed: ${r.url()}`)
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource: net::/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  return errors
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `test-results/${name}-light.png`, fullPage: true })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.waitForTimeout(300)
  await page.screenshot({ path: `test-results/${name}-dark.png`, fullPage: true })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'horizontal page scroll at 390px').toBeLessThanOrEqual(0)
  await page.screenshot({ path: `test-results/${name}-phone.png`, fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })
}

test.beforeAll(() => {
  const f = fixtures()
  roleName = `E2E Viewer ${f.run}`
  staffEmail = `e2e-role-staff-${f.run}@example.test`
})

test.afterAll(async () => {
  const admin = adminClient(loadE2EEnv())
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const staff = data.users.find((u) => u.email === staffEmail)
  if (!staff) return
  await admin.from('audit_logs').delete().eq('actor_user_id', staff.id)
  await admin.from('user_profiles').delete().eq('user_id', staff.id)
  await admin.auth.admin.deleteUser(staff.id)
})

test.describe.serial('agency roles', () => {
  test.describe('the Super Admin', () => {
    test.use(auth('agencyA'))

    test('builds a role: an action ticks the view it needs', async ({ page }) => {
      const errors = watchErrors(page)
      await page.goto('/agency/users')
      await page.waitForLoadState('networkidle')
      await page.getByRole('tab', { name: /^Roles/ }).click()
      await expect(page.getByText('Super Admin', { exact: true })).toBeVisible()
      await expect(page.getByText('Admin', { exact: true })).toBeVisible()

      await page.getByRole('button', { name: 'New role' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Name').fill(roleName)
      await dialog.getByRole('checkbox', { name: 'Approve / reject limit requests' }).click()
      await expect(dialog.getByRole('checkbox', { name: 'View limit requests' })).toBeChecked()
      await dialog.getByRole('checkbox', { name: 'View clients' }).click()
      await expect(dialog.getByText('3 selected')).toBeVisible()
      await page.screenshot({ path: 'test-results/agency-role-dialog-light.png' })
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
      await page.waitForTimeout(300)
      await page.screenshot({ path: 'test-results/agency-role-dialog-dark.png' })
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
      await dialog.getByRole('button', { name: 'Create role' }).click()
      await expect(page.getByText(`Role “${roleName}” created`)).toBeVisible()
      await expect(page.getByText(roleName, { exact: true })).toBeVisible()
      await expect(page.getByText(/0 logins · 3 of \d+ permissions/)).toBeVisible()
      await shoot(page, 'agency-roles-tab')
      expect(errors).toEqual([])
    })

    test('gives a new staff login that role', async ({ page }) => {
      const errors = watchErrors(page)
      await page.goto('/agency/users')
      await page.waitForLoadState('networkidle')
      await page.getByRole('button', { name: 'New staff login' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Full name').fill('E2E Role Staff')
      await dialog.getByLabel('Email').fill(staffEmail)
      await dialog.getByLabel('Temporary password').fill(PASSWORD)
      await dialog.getByRole('combobox').click()
      await page.getByRole('option', { name: roleName }).click()
      await dialog.getByRole('button', { name: 'Create user' }).click()
      await expect(page.getByText('Staff login created')).toBeVisible()
      const row = page.getByRole('row').filter({ hasText: staffEmail })
      await expect(row).toContainText(roleName)
      await shoot(page, 'agency-staff-tab')

      // Keep this Super Admin's payments-list call, to replay on the new login.
      const captured = page.waitForRequest((r) => {
        const m = /\/_serverFn\/([^?]+)/.exec(r.url())
        return !!m && Buffer.from(m[1], 'base64url').toString().includes('listPaymentsFn')
      })
      await page.goto('/agency/payments')
      const req = await captured
      const { cookie: _drop, ...headers } = await req.allHeaders()
      paymentsCall = { url: req.url(), headers }
      expect(errors).toEqual([])
    })
  })

  test.describe('the new staff login', () => {
    let context: BrowserContext
    let page: Page

    test.beforeAll(async ({ browser }) => {
      const { cookies } = await sessionCookies(loadE2EEnv(), staffEmail)
      context = await browser.newContext()
      await context.addCookies(cookies)
      page = await context.newPage()
    })
    test.afterAll(async () => {
      await context.close()
    })

    test('sees only its role’s pages, and lands on the first one', async () => {
      const errors = watchErrors(page)
      await page.goto('/agency')
      await expect(page).toHaveURL(/\/agency\/clients$/)
      await page.waitForLoadState('networkidle')
      const nav = page.getByRole('navigation').first()
      await expect(nav.getByRole('link', { name: 'Clients' })).toBeVisible()
      await expect(nav.getByRole('link', { name: 'Limit Requests' })).toBeVisible()
      await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible()
      for (const hidden of ['Dashboard', 'Ad Accounts', 'Payments', 'Ledger', 'Users', 'Audit Log']) {
        await expect(nav.getByRole('link', { name: hidden, exact: true })).toHaveCount(0)
      }
      // Clients it can view, not change.
      await expect(page.getByText(fixtures().clientAName)).toBeVisible()
      await expect(page.getByRole('button', { name: 'New client' })).toHaveCount(0)

      await page.goto('/agency/payments')
      await expect(page.getByText('You don’t have access to this page')).toBeVisible()
      await page.goto('/agency/users')
      await page.waitForLoadState('networkidle')
      await expect(page.getByText('You don’t have access to this page')).toBeVisible()

      await page.getByRole('button', { name: /E2E Role Staff|ER/ }).first().click()
      await expect(page.getByText(`Role: ${roleName}`)).toBeVisible()
      await page.keyboard.press('Escape')
      expect(errors).toEqual([])
    })

    test('the server refuses what the role lacks', async () => {
      expect(paymentsCall).not.toBeNull()
      const res = await context.request.get(paymentsCall!.url, { headers: paymentsCall!.headers })
      const body = await res.text()
      expect(body).toContain('Missing permission: payments.view')
    })

    test('a role change applies on the next page load', async ({ browser }) => {
      // The Super Admin moves the login onto the built-in "Admin" role.
      const sa = await browser.newContext({ storageState: 'e2e/.auth/agencyA.json' })
      const saPage = await sa.newPage()
      await saPage.goto('/agency/users')
      await saPage.waitForLoadState('networkidle')
      const row = saPage.getByRole('row').filter({ hasText: staffEmail })
      await row.getByRole('button', { name: /^Actions for/ }).click()
      await saPage.getByRole('menuitem', { name: 'Change role…' }).click()
      const dialog = saPage.getByRole('dialog')
      await dialog.getByRole('combobox').click()
      await saPage.getByRole('option', { name: 'Admin', exact: true }).click()
      await dialog.getByRole('button', { name: 'Save role' }).click()
      await expect(saPage.getByText('Role updated')).toBeVisible()
      await sa.close()

      await page.goto('/agency/payments')
      await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible()
      await expect(page.getByText('You don’t have access to this page')).toHaveCount(0)
      // Still no Users page: the built-in Admin role can view users but not
      // manage them, so it gets no "New staff login" button.
      await page.goto('/agency/users')
      await expect(page.getByRole('button', { name: 'New staff login' })).toHaveCount(0)
    })
  })
})
