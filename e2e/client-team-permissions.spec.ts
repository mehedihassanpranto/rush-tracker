import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { PASSWORD, adminClient, sessionCookies } from './support/seed'

/**
 * Client team permissions (2026-11-28, migration 000069): the client's
 * Owner adds a Member who may only request limits. The Member sees no
 * billing — not in the menu, not on the dashboard, not at the server — and
 * can't manage the team. Given "See billing" and "Manage team", it can, but
 * still can't make Owners or touch the Owner. The agency sees and edits the
 * same access on the client's Logins tab. The Member login is removed in
 * afterAll.
 */

let memberEmail = ''
let dueCall: { url: string; headers: Record<string, string> } | null = null

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
  memberEmail = `e2e-team-member-${fixtures().run}@example.test`
})

test.afterAll(async () => {
  const admin = adminClient(loadE2EEnv())
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const member = data.users.find((u) => u.email === memberEmail)
  if (!member) return
  await admin.from('audit_logs').delete().eq('actor_user_id', member.id)
  await admin.from('client_memberships').delete().eq('user_id', member.id)
  await admin.from('user_profiles').delete().eq('user_id', member.id)
  await admin.auth.admin.deleteUser(member.id)
})

test.describe.serial('client team permissions', () => {
  test.describe('the Owner', () => {
    test.use(auth('client'))

    test('adds a Member who may only request limits', async ({ page }) => {
      const errors = watchErrors(page)
      await page.goto('/client/team')
      await page.waitForLoadState('networkidle')
      const me = page.getByRole('row').filter({ hasText: '(you)' })
      await expect(me).toContainText('Owner')
      // Nobody edits themself.
      await expect(me.getByRole('button')).toHaveCount(0)

      await page.getByRole('button', { name: 'Add team member' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Full name').fill('E2E Team Member')
      await dialog.getByLabel('Email').fill(memberEmail)
      await dialog.getByLabel('Temporary password').fill(PASSWORD)
      await expect(dialog.getByRole('checkbox', { name: 'Owner' })).not.toBeChecked()
      await expect(dialog.getByRole('checkbox', { name: 'Request limits' })).toBeChecked()
      await expect(dialog.getByRole('checkbox', { name: 'See billing' })).not.toBeChecked()
      await dialog.getByRole('button', { name: /^Add/ }).click()
      await expect(page.getByText('Teammate added')).toBeVisible()
      const row = page.getByRole('row').filter({ hasText: memberEmail })
      await expect(row).toContainText('Request limits')
      await shoot(page, 'client-team')

      // Keep the Owner's due call, to replay on the Member's session.
      const captured = page.waitForRequest((r) => {
        const m = /\/_serverFn\/([^?]+)/.exec(r.url())
        return !!m && Buffer.from(m[1], 'base64url').toString().includes('getMyDueFn')
      })
      await page.goto('/client/due')
      const req = await captured
      const { cookie: _drop, ...headers } = await req.allHeaders()
      dueCall = { url: req.url(), headers }
      expect(errors).toEqual([])
    })
  })

  test.describe('the Member', () => {
    let context: BrowserContext
    let page: Page

    test.beforeAll(async ({ browser }) => {
      const { cookies } = await sessionCookies(loadE2EEnv(), memberEmail)
      context = await browser.newContext()
      await context.addCookies(cookies)
      page = await context.newPage()
    })
    test.afterAll(async () => {
      await context.close()
    })

    test('sees no billing anywhere, and no team controls', async () => {
      const errors = watchErrors(page)
      await page.goto('/client')
      await page.waitForLoadState('networkidle')
      const nav = page.getByRole('navigation').first()
      await expect(nav.getByRole('link', { name: 'My Ad Accounts' })).toBeVisible()
      await expect(nav.getByRole('link', { name: 'Limit Requests' })).toBeVisible()
      for (const hidden of ['Due & Payments', 'Payment Requests', 'Statement']) {
        await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0)
      }
      await expect(page.getByText('Total Approved Limit (USD)')).toBeVisible()
      for (const money of ['Current Due (BDT)', 'Total Paid (BDT)', 'Recent Payments', 'Recent Transactions', 'You paid']) {
        await expect(page.getByText(money, { exact: true })).toHaveCount(0)
      }
      await shoot(page, 'client-member-dashboard')

      await page.goto('/client/due')
      await expect(page.getByText('You don’t have access to this page')).toBeVisible()

      await page.goto('/client/limit-requests')
      await page.waitForLoadState('networkidle')
      await expect(page.getByRole('button', { name: 'New request' })).toBeVisible()

      await page.goto('/client/team')
      await page.waitForLoadState('networkidle')
      await expect(page.getByRole('button', { name: 'Add team member' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Edit access|Deactivate/ })).toHaveCount(0)
      expect(errors).toEqual([])
    })

    test('the server refuses billing', async () => {
      expect(dueCall).not.toBeNull()
      const res = await context.request.get(dueCall!.url, { headers: dueCall!.headers })
      expect(await res.text()).toContain('Missing permission: billing.view')
    })

    test('given billing and team, it manages Members but never the Owner', async ({ browser }) => {
      const owner = await browser.newContext({ storageState: 'e2e/.auth/client.json' })
      const ownerPage = await owner.newPage()
      await ownerPage.goto('/client/team')
      await ownerPage.waitForLoadState('networkidle')
      await ownerPage.getByRole('row').filter({ hasText: memberEmail }).getByRole('button', { name: 'Edit access' }).click()
      const dialog = ownerPage.getByRole('dialog')
      await dialog.getByRole('checkbox', { name: 'See billing' }).click()
      await dialog.getByRole('checkbox', { name: 'Manage team' }).click()
      await dialog.getByRole('button', { name: 'Save access' }).click()
      await expect(ownerPage.getByText('Access updated')).toBeVisible()
      await owner.close()

      await page.goto('/client/due')
      await page.waitForLoadState('networkidle')
      await expect(page.getByRole('heading', { name: 'Due & Payments' })).toBeVisible()
      // Seeing billing isn't paying.
      await expect(page.getByRole('button', { name: 'Pay due' })).toHaveCount(0)

      await page.goto('/client/team')
      await page.waitForLoadState('networkidle')
      const ownerRow = page.getByRole('row').filter({ hasText: 'Owner' }).filter({ hasNotText: memberEmail })
      await expect(ownerRow.getByRole('button')).toHaveCount(0)
      await page.getByRole('button', { name: 'Add team member' }).click()
      const add = page.getByRole('dialog')
      await expect(add.getByRole('checkbox', { name: 'Owner' })).toBeDisabled()
      await expect(add.getByRole('checkbox', { name: 'Make payments' })).toBeDisabled()
      await expect(add.getByRole('checkbox', { name: 'See billing' })).toBeEnabled()
    })
  })

  test.describe('the agency', () => {
    test.use(auth('agencyA'))

    test('sees and edits the same access on the Logins tab', async ({ page }) => {
      const errors = watchErrors(page)
      await page.goto(`/agency/clients/${fixtures().clientA}`)
      await page.waitForLoadState('networkidle')
      await page.getByRole('tab', { name: /^Logins/ }).click()
      const row = page.getByRole('row').filter({ hasText: memberEmail })
      await expect(row).toContainText('Request limits · See billing · Manage team')
      // The dev-tools badge sits over the row's last column; use the keyboard.
      await row.getByRole('button').focus()
      await page.keyboard.press('Enter')
      await page.getByRole('menuitem', { name: 'Edit portal access…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('checkbox', { name: 'Owner' }).click()
      await dialog.getByRole('button', { name: 'Save access' }).click()
      await expect(page.getByText('Portal access updated')).toBeVisible()
      await expect(row).toContainText('Owner')
      expect(errors).toEqual([])
    })
  })
})
