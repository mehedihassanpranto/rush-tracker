import { expect, test } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient } from './support/seed'

// Runs against the e2e dev server, whose CRON_SECRET and Meta token are the
// inert value from playwright.config.ts — so the cron really runs, and the
// Meta token check really reports "not working".
const CRON_SECRET = 'e2e-disabled'
test.describe.configure({ mode: 'serial' })

test('an unexpected server-function error is recorded', async ({ browser }) => {
  const f = fixtures()
  const since = new Date().toISOString()
  const ctx = await browser.newContext(auth('agencyA'))
  const page = await ctx.newPage()
  // Agency A opening agency B's client: getClientFn throws (not found).
  await page.goto(`/agency/clients/${f.clientB}`)
  await page.waitForLoadState('networkidle')
  await ctx.close()

  const admin = adminClient(loadE2EEnv())
  await expect
    .poll(async () => {
      const { data } = await admin
        .from('app_errors')
        .select('fn_name, source')
        .gte('occurred_at', since)
      return (data ?? []).filter((r) => r.source === 'server_fn' && /getClient/.test(r.fn_name ?? '')).length
    })
    .toBeGreaterThan(0)
})

test('the cron refuses a missing secret, and records its run', async ({ request }) => {
  expect((await request.get('/api/cron/meta-sync')).status()).toBe(401)

  const since = new Date().toISOString()
  const res = await request.get('/api/cron/meta-sync', {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
    timeout: 120_000,
  })
  expect([200, 502]).toContain(res.status())

  const admin = adminClient(loadE2EEnv())
  const { data } = await admin
    .from('cron_runs')
    .select('status, finished_at, summary')
    .eq('job', 'meta-sync')
    .gte('started_at', since)
  expect(data?.length).toBe(1)
  // The inert platform token makes the pool sync fail inside an otherwise
  // completed run — that must be recorded as partial, not success.
  expect(data![0].status).toBe('partial')
  expect(data![0].finished_at).not.toBeNull()
  expect((data![0].summary as { trigger: { host: string } }).trigger.host).toContain('localhost')
})

test('a broken token alerts once, not on every run', async ({ request }) => {
  const f = fixtures()
  // Test 2 already ran the cron once (alerting). Run it again.
  await request.get('/api/cron/meta-sync', {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
    timeout: 120_000,
  })
  const admin = adminClient(loadE2EEnv())
  const { data } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', f.users.platform.id)
    .eq('type', 'META_TOKEN')
  expect(data?.length).toBe(1)
})

test.describe('System health page', () => {
  test.use(auth('platform'))

  test('shows the run and the broken platform token', async ({ page }) => {
    await page.goto('/platform/health')
    await expect(page.getByText('Daily Meta sync')).toBeVisible()
    const tokenRow = page.getByRole('row', { name: /Platform \(ad account pool\)/ })
    await expect(tokenRow).toBeVisible()
    await expect(tokenRow.getByText('Not working')).toBeVisible()
    await expect(page.getByText(/in 24 h/)).toBeVisible()
  })
})
