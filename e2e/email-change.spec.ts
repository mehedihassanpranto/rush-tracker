import { expect, test } from '@playwright/test'
import { fixtures } from './support/fixtures'
import { loadE2EEnv } from './support/env'
import { adminClient, emailChangeTokens } from './support/seed'
import { signIn } from './support/sign-in'

// The refusal checks run first, while the account still has its seeded email.
test.describe.configure({ mode: 'serial' })

test('an email change is refused before anything is sent: same email, taken email, wrong password', async ({ page }) => {
  const f = fixtures()
  const me = f.securityUsers.emailUser
  await signIn(page, me.email)
  await expect(page).toHaveURL(/\/agency/)
  await page.goto('/security')
  await page.waitForLoadState('networkidle')
  await expect(page.getByText(`You sign in with ${me.email}`)).toBeVisible()

  const submit = async (email: string, password: string) => {
    await page.getByLabel('New email').fill(email)
    await page.getByLabel('Your password').fill(password)
    await page.getByRole('button', { name: 'Send confirmation links' }).click()
  }
  await submit(me.email, 'E2e-Pass-1234!')
  await expect(page.getByText('That is already your sign-in email.')).toBeVisible()
  await submit(f.users.agencyB.email, 'E2e-Pass-1234!')
  await expect(page.getByText('That email address is already used by another account.')).toBeVisible()
  await submit(`changed-${f.run}@example.test`, 'Not-My-Password-1!')
  await expect(page.getByText('Your current password is not correct.')).toBeVisible()

  const { data } = await adminClient(loadE2EEnv()).auth.admin.getUserById(me.id)
  expect(data.user?.new_email ?? null).toBeNull()
})

test('the email changes only after BOTH links are confirmed, and confirming never signs anyone in', async ({ browser }) => {
  const f = fixtures()
  const env = loadE2EEnv()
  const admin = adminClient(env)
  const me = f.securityUsers.emailUser
  const newEmail = `changed-${f.run}@example.test`
  const tokens = await emailChangeTokens(env, me.email, newEmail)

  // A device that isn't signed in — e.g. the phone the email is read on.
  const context = await browser.newContext()
  const page = await context.newPage()
  const emailNow = async () => (await admin.auth.admin.getUserById(me.id)).data.user?.email

  // Opening the link does nothing by itself (mail scanners open links).
  await page.goto(`/confirm-email?token_hash=${tokens.current}`)
  await page.waitForLoadState('networkidle')
  expect(await emailNow()).toBe(me.email)

  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText(/One more step/)).toBeVisible()
  expect(await emailNow()).toBe(me.email)

  await page.goto(`/confirm-email?token_hash=${tokens.next}`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText(`Your sign-in email is now ${newEmail}`)).toBeVisible()
  expect(await emailNow()).toBe(newEmail)

  // No session was handed to the device that clicked.
  const cookies = await context.cookies()
  expect(cookies.filter((c) => c.name.includes('auth-token'))).toEqual([])

  // Single use.
  await page.goto(`/confirm-email?token_hash=${tokens.current}`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText(/invalid, has expired, or was already used/)).toBeVisible()

  // The new address signs in; the old one no longer does.
  await signIn(page, me.email)
  await expect(page.getByText('Invalid email or password.')).toBeVisible()
  await signIn(page, newEmail)
  await expect(page).toHaveURL(/\/agency/)

  const { data: audit } = await admin
    .from('audit_logs')
    .select('action')
    .eq('entity_id', me.id)
    .eq('action', 'EMAIL_CHANGED')
  expect(audit?.length).toBe(1)
  await context.close()
})
