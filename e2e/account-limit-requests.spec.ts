import { expect, test } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient } from './support/seed'
import type { Page } from '@playwright/test'

/**
 * An ad account's Limit Requests tab (2026-10-27): every request on the
 * account, any status, newest first, each linking to its request — on the
 * agency's account page and, for a pool account, the platform's (with the
 * agency, without the agency's BDT charge), and the client's own account
 * page (Overview + its Limit Requests). Another agency can't read an
 * account's history by id, nor a client an account that isn't theirs. Org A's account and requests go with global
 * teardown; the pool account is removed in afterAll.
 */

let ownAccount = ''
let poolAccount = ''
const numbers: Record<string, string> = {}

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

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

test.beforeAll(async () => {
  const admin = adminClient(loadE2EEnv())
  const f = fixtures()

  // Find-or-create both accounts, so a retry doesn't seed the history twice.
  async function account(name: string, pool: boolean) {
    const { data: found } = await admin.from('ad_accounts').select('id').eq('name', name).maybeSingle()
    if (found) return { id: found.id as string, fresh: false }
    const { data, error } = await admin
      .from('ad_accounts')
      .insert({ name, platform: 'META', status: 'ACTIVE', is_platform: pool, organization_id: pool ? null : f.orgA, usd_rate: 0 })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    if (pool) await admin.from('platform_account_grants').insert({ ad_account_id: data.id, organization_id: f.orgA })
    return { id: data.id as string, fresh: true }
  }
  async function seedRequests(accountId: string, rows: Array<Record<string, unknown> & { key: string }>) {
    const { data: asg, error } = await admin
      .from('ad_account_assignments')
      .insert({ ad_account_id: accountId, client_id: f.clientA, opening_limit_usd: 0, organization_id: f.orgA })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    for (const { key, ...row } of rows) {
      const { error: lrErr } = await admin.from('limit_requests').insert({
        client_id: f.clientA, ad_account_id: accountId, organization_id: f.orgA, assignment_id: asg.id,
        opening_balance_usd: 0, default_usd_rate: 125, segment: 'postpaid', ...row,
      })
      if (lrErr) throw new Error(`${key}: ${lrErr.message}`)
    }
  }

  const own = await account(`ZZ E2E LR history ${f.run}`, false)
  ownAccount = own.id
  if (own.fresh) {
    await seedRequests(ownAccount, [
      { key: 'approved', status: 'APPROVED', requested_amount_usd: 50, expected_new_limit_usd: 50, total_cost_bdt: 6250,
        approved_amount_usd: 50, approved_usd_rate: 125, approved_new_limit_usd: 50, bdt_charge: 6250,
        requested_at: ago(90), approved_at: ago(80) },
      { key: 'rejected', status: 'REJECTED', requested_amount_usd: 900, expected_new_limit_usd: 950, total_cost_bdt: 112500,
        rejection_reason: 'e2e too much', requested_at: ago(60), reviewed_at: ago(50) },
      { key: 'pending', status: 'PENDING', requested_amount_usd: 25, expected_new_limit_usd: 75, total_cost_bdt: 3125,
        opening_balance_usd: 50, requested_at: ago(10) },
    ])
  }
  const pool = await account(`ZZ E2E LR pool ${f.run}`, true)
  poolAccount = pool.id
  if (pool.fresh) {
    // No approval here: approving on a pool account bills the agency.
    await seedRequests(poolAccount, [
      { key: 'cancelled', status: 'CANCELLED', requested_amount_usd: 40, expected_new_limit_usd: 40, total_cost_bdt: 5000, requested_at: ago(30) },
      { key: 'pool-pending', status: 'PENDING', requested_amount_usd: 15, expected_new_limit_usd: 15, total_cost_bdt: 1875, requested_at: ago(5) },
    ])
  }

  const { data: rows } = await admin
    .from('limit_requests')
    .select('request_number, status, ad_account_id')
    .in('ad_account_id', [ownAccount, poolAccount])
  for (const r of rows ?? []) numbers[`${r.ad_account_id === poolAccount ? 'pool-' : ''}${r.status}`] = r.request_number
})

test.afterAll(async () => {
  if (!poolAccount) return
  const admin = adminClient(loadE2EEnv())
  await admin.from('limit_requests').delete().eq('ad_account_id', poolAccount)
  await admin.from('ad_account_assignments').delete().eq('ad_account_id', poolAccount)
  await admin.from('platform_account_grants').delete().eq('ad_account_id', poolAccount)
  await admin.from('ad_accounts').delete().eq('id', poolAccount)
})

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `test-results/${name}-light.png`, fullPage: true })
  await page.getByRole('button', { name: /Switch to dark mode/ }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `test-results/${name}-dark.png`, fullPage: true })
  await page.getByRole('button', { name: /Switch to light mode/ }).click()
  await page.waitForTimeout(600)
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'horizontal page scroll at 390px').toBeLessThanOrEqual(0)
  await page.screenshot({ path: `test-results/${name}-phone.png`, fullPage: true })
}

test.describe('the agency', () => {
  test.use(auth('agencyA'))

  test('sees every request on its account, newest first', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(`/agency/ad-accounts/${ownAccount}`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('tab', { name: 'Limit Requests (3)' }).click()

    await expect(page.locator('[data-slot="card"]').filter({ hasText: 'Total USD used' })).toContainText('$50.00')
    const body = page.locator('tbody tr')
    await expect(body).toHaveCount(3)
    await expect(body.nth(0)).toContainText(numbers.PENDING)
    await expect(body.nth(0)).toContainText('Pending')
    await expect(body.nth(1)).toContainText(numbers.REJECTED)
    await expect(body.nth(1)).toContainText('e2e too much')
    await expect(body.nth(2)).toContainText(numbers.APPROVED)
    await expect(body.nth(2)).toContainText('Approved')
    await expect(body.nth(2)).toContainText('৳6,250')
    await expect(page.getByRole('columnheader', { name: 'Charge' })).toBeVisible()

    await shoot(page, 'account-limit-requests')
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.getByRole('link', { name: numbers.REJECTED }).click()
    await expect(page).toHaveURL(/\/agency\/limit-requests\/[0-9a-f-]{36}$/)
    await expect(page.getByText(numbers.REJECTED).first()).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('the platform', () => {
  test.use(auth('platform'))

  test('sees a pool account’s requests with the agency, not its charge', async ({ page }) => {
    const errors = watchErrors(page)
    const { data: org } = await adminClient(loadE2EEnv()).from('organizations').select('name').eq('id', fixtures().orgA).single()
    await page.goto(`/platform/ad-accounts/${poolAccount}`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('tab', { name: 'Limit Requests (2)' }).click()

    const body = page.locator('tbody tr')
    await expect(body).toHaveCount(2)
    await expect(body.nth(0)).toContainText(numbers['pool-PENDING'])
    await expect(body.nth(0)).toContainText(org!.name)
    await expect(body.nth(1)).toContainText(numbers['pool-CANCELLED'])
    await expect(body.nth(1)).toContainText('Cancelled')
    await expect(page.getByRole('columnheader', { name: 'Agency' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Charge' })).toHaveCount(0)

    await shoot(page, 'pool-account-limit-requests')
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.getByRole('link', { name: numbers['pool-PENDING'] }).click()
    await expect(page).toHaveURL(/\/platform\/limit-requests\/[0-9a-f-]{36}$/)
    expect(errors).toEqual([])
  })
})

test.describe('another agency', () => {
  test.use(auth('agencyB'))

  test('cannot read the account’s requests by id', async ({ page }) => {
    const f = fixtures()
    const { data: acct } = await adminClient(loadE2EEnv()).from('ad_accounts').select('id').eq('name', f.accountBName).single()
    const accountB = acct!.id as string
    // Agency B's own account page asks for its history; replay that request
    // with agency A's account swapped in, on B's session.
    const isHistoryFn = (url: string) => {
      const m = /\/_serverFn\/([^?]+)/.exec(url)
      return !!m && Buffer.from(m[1], 'base64url').toString().includes('listAdAccountLimitRequestsFn')
    }
    const captured = page.waitForRequest((r) => isHistoryFn(r.url()) && r.url().includes(accountB))
    await page.goto(`/agency/ad-accounts/${accountB}`)
    const req = await captured
    const headers = await req.allHeaders()

    const own = await page.request.get(req.url(), { headers })
    expect(own.ok(), 'its own account').toBe(true)

    const other = await page.request.get(req.url().replaceAll(accountB, ownAccount), { headers })
    expect(other.ok()).toBe(true)
    const body = await other.text()
    for (const n of [numbers.PENDING, numbers.REJECTED, numbers.APPROVED]) expect(body).not.toContain(n)
    expect(body).not.toContain('e2e too much')
  })
})

test.describe('the client', () => {
  test.use(auth('client'))

  test('opens its account: overview and its own requests', async ({ page }) => {
    const errors = watchErrors(page)
    const f = fixtures()
    await page.goto('/client/ad-accounts')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: `ZZ E2E LR history ${f.run}` }).click()
    await expect(page).toHaveURL(new RegExp(`/client/ad-accounts/${ownAccount}$`))
    await page.waitForLoadState('networkidle')

    const card = (label: string) => page.locator('[data-slot="card"]').filter({ hasText: label }).first()
    await expect(card('Approved for you')).toContainText('$50.00')
    await expect(card('Approved for you')).toContainText('1 approved request')
    await expect(card('Account details')).toContainText('Limit when assigned')
    await expect(card('Account details')).toContainText('Postpaid')
    await expect(card('Account details')).toContainText('Not set')
    // One request is still pending, so another can't be raised yet.
    await expect(page.getByRole('button', { name: 'Request pending' })).toBeDisabled()

    await page.getByRole('tab', { name: 'Limit Requests (3)' }).click()
    const body = page.locator('tbody tr')
    await expect(body).toHaveCount(3)
    await expect(body.nth(0)).toContainText(numbers.PENDING)
    await expect(body.nth(0).getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(body.nth(1)).toContainText(numbers.REJECTED)
    await expect(body.nth(2)).toContainText(numbers.APPROVED)
    await expect(page.getByRole('columnheader', { name: 'Account' })).toHaveCount(0)

    await page.getByRole('tab', { name: 'Overview' }).click()
    await shoot(page, 'client-account')
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole('tab', { name: 'Limit Requests (3)' }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, 'horizontal page scroll at 390px (requests tab)').toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })

  test('cannot open an account that isn’t theirs', async ({ page }) => {
    const { data: acct } = await adminClient(loadE2EEnv()).from('ad_accounts').select('id').eq('name', fixtures().accountBName).single()
    await page.goto(`/client/ad-accounts/${acct!.id}`)
    await expect(page.getByText('This ad account isn’t assigned to you.')).toBeVisible()
    await expect(page.locator('tbody tr')).toHaveCount(0)
  })
})
