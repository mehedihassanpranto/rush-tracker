import { expect, test } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient } from './support/seed'
import type { Page } from '@playwright/test'

/**
 * Editing a client's USD rate can also set it on the client's ad accounts
 * (2026-11-23). An account's own rate wins over the client's, so before this
 * a new client rate (130 → 134) never reached accounts that already had one.
 * Only that client's ACTIVE accounts change; another client's account at the
 * old rate stays put, and unticking the box leaves the accounts alone. The
 * client and its own account go with global teardown; the pool accounts are
 * removed in afterAll.
 */

let clientId = ''
let ownAccount = ''
let otherClientAccount = ''
const poolAccounts: Array<string> = []

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

test.beforeAll(async () => {
  const admin = adminClient(loadE2EEnv())
  const f = fixtures()

  const name = `ZZ E2E rate client ${f.run}`
  const { data: found } = await admin.from('clients').select('id').eq('name', name).maybeSingle()
  if (found) {
    clientId = found.id as string
  } else {
    const { data, error } = await admin
      .from('clients')
      .insert({ name, organization_id: f.orgA, usd_rate: 130, segment: 'postpaid', status: 'ACTIVE' })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    clientId = data.id as string
  }
  // Re-runs start from the same rates.
  await admin.from('clients').update({ usd_rate: 130 }).eq('id', clientId)

  async function account(label: string, rate: number, pool: boolean, holder: string) {
    const accountName = `ZZ E2E rate ${label} ${f.run}`
    let { data: row } = await admin.from('ad_accounts').select('id').eq('name', accountName).maybeSingle()
    if (!row) {
      const { data, error } = await admin
        .from('ad_accounts')
        .insert({ name: accountName, platform: 'META', status: 'ACTIVE', is_platform: pool, organization_id: pool ? null : f.orgA, usd_rate: rate })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      row = data
      if (pool) await admin.from('platform_account_grants').insert({ ad_account_id: data.id, organization_id: f.orgA })
      const { error: asgErr } = await admin
        .from('ad_account_assignments')
        .insert({ ad_account_id: data.id, client_id: holder, opening_limit_usd: 0, organization_id: f.orgA })
      if (asgErr) throw new Error(asgErr.message)
    }
    await admin.from('ad_accounts').update({ usd_rate: rate }).eq('id', row.id)
    return row.id as string
  }

  poolAccounts.push(await account('pool 130', 130, true, clientId))
  poolAccounts.push(await account('pool 131', 131, true, clientId))
  ownAccount = await account('own 0', 0, false, clientId)
  otherClientAccount = await account('other client', 130, false, f.clientA)
})

test.afterAll(async () => {
  if (poolAccounts.length === 0) return
  const admin = adminClient(loadE2EEnv())
  await admin.from('ad_account_assignments').delete().in('ad_account_id', poolAccounts)
  await admin.from('platform_account_grants').delete().in('ad_account_id', poolAccounts)
  await admin.from('ad_accounts').delete().in('id', poolAccounts)
})

async function rates() {
  const admin = adminClient(loadE2EEnv())
  const { data } = await admin
    .from('ad_accounts')
    .select('id, usd_rate')
    .in('id', [...poolAccounts, ownAccount, otherClientAccount])
  const by = new Map((data ?? []).map((r) => [r.id as string, Number(r.usd_rate)]))
  return {
    pool130: by.get(poolAccounts[0]),
    pool131: by.get(poolAccounts[1]),
    own: by.get(ownAccount),
    other: by.get(otherClientAccount),
  }
}

async function openEdit(page: Page) {
  await page.goto(`/agency/clients/${clientId}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Edit client' })).toBeVisible()
  return dialog
}

test.describe.serial('client rate → ad accounts', () => {
  test.use(auth('agencyA'))

  test('a new client rate is set on all of that client’s accounts', async ({ page }) => {
    const errors = watchErrors(page)
    const dialog = await openEdit(page)
    const rate = dialog.getByLabel('USD rate (BDT per $1)')
    const box = dialog.getByRole('checkbox', { name: /Also use/ })

    // At the client's current rate, only the 131 account is off it — the
    // unset (0) one already follows the client.
    await expect(dialog.getByText('Also use ৳130 on 1 ad account (now ৳131)')).toBeVisible()

    await rate.fill('134')
    await expect(dialog.getByText('Also use ৳134 on 2 ad accounts (now ৳130, ৳131)')).toBeVisible()
    await expect(box).toBeChecked()

    await page.screenshot({ path: 'test-results/client-rate-dialog-light.png' })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-results/client-rate-dialog-dark.png' })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Client updated · rate set on 2 ad accounts')).toBeVisible()

    expect(await rates()).toEqual({ pool130: 134, pool131: 134, own: 0, other: 130 })

    // The Rate column on the client page follows without a reload.
    await page.getByRole('tab', { name: /^Ad Accounts/ }).click()
    const table = page.getByRole('tabpanel').getByRole('table')
    await expect(table.getByRole('cell', { name: '৳134', exact: true })).toHaveCount(3)
    await expect(table.getByRole('cell', { name: /^৳13[01]$/ })).toHaveCount(0)

    const admin = adminClient(loadE2EEnv())
    const { data: audit } = await admin
      .from('audit_logs')
      .select('entity_id, old_values, new_values, metadata')
      .eq('action', 'AD_ACCOUNT_UPDATED')
      .in('entity_id', [...poolAccounts, ownAccount, otherClientAccount])
      .contains('metadata', { source: 'CLIENT_RATE_APPLIED' })
    expect(audit).toHaveLength(2)
    for (const a of audit ?? []) {
      expect(a.new_values).toEqual({ usd_rate: 134 })
      expect(a.metadata).toEqual({ source: 'CLIENT_RATE_APPLIED', client_id: clientId })
    }

    // Saved again at the same rate: nothing left to offer.
    const again = await openEdit(page)
    await expect(again.getByLabel('USD rate (BDT per $1)')).toHaveValue('134')
    await expect(again.getByRole('checkbox', { name: /Also use/ })).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('unticked, only the client’s rate changes', async ({ page }) => {
    const errors = watchErrors(page)
    const dialog = await openEdit(page)
    await dialog.getByLabel('USD rate (BDT per $1)').fill('135')
    const box = dialog.getByRole('checkbox', { name: /Also use ৳135 on 2 ad accounts/ })
    await box.click()
    await expect(box).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('Client updated', { exact: true })).toBeVisible()

    const admin = adminClient(loadE2EEnv())
    const { data: client } = await admin.from('clients').select('usd_rate').eq('id', clientId).single()
    expect(Number(client!.usd_rate)).toBe(135)
    expect(await rates()).toEqual({ pool130: 134, pool131: 134, own: 0, other: 130 })
    expect(errors).toEqual([])
  })

  test('phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const dialog = await openEdit(page)
    await dialog.getByLabel('USD rate (BDT per $1)').fill('136')
    await expect(dialog.getByRole('checkbox', { name: /Also use ৳136 on 2 ad accounts/ })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, 'horizontal page scroll at 390px').toBeLessThanOrEqual(0)
    await page.screenshot({ path: 'test-results/client-rate-dialog-phone.png', fullPage: true })
  })
})
