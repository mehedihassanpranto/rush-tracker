import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { auth, fixtures } from './support/fixtures'
import { PASSWORD } from './support/seed'
import { totp } from './support/totp'

// Signs in through the real login form (no injected session), like a person.
async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login')
  // Wait for the app's JS, so the form is handled by the app rather than
  // the browser's native submit.
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('credential forms never fall back to GET (no password in the URL)', async ({ request }) => {
  // Server-rendered HTML — what a browser submits if clicked before the JS
  // loads. A GET form would put the password in the URL, history and logs.
  for (const path of ['/login', '/forgot-password']) {
    const html = await (await request.get(path)).text()
    const forms = html.match(/<form[^>]*>/g) ?? []
    expect(forms.length, `${path} has a form`).toBeGreaterThan(0)
    for (const tag of forms) expect(tag, `${path}: ${tag}`).toMatch(/method="post"/)
  }
})

// Order matters: 2FA is set up, then required, then reset by an admin.
test.describe.configure({ mode: 'serial' })

test('a platform admin without 2FA must set it up before anything else', async ({ page }) => {
  const f = fixtures()
  await signIn(page, f.securityUsers.platformNew.email)
  await expect(page).toHaveURL(/\/mfa\/setup/)
  // No way around it by URL.
  await page.goto('/platform/organizations')
  await expect(page).toHaveURL(/\/mfa\/setup/)
  await expect(page.getByText('Set up two-factor sign-in')).toBeVisible()
})

let mfaSecret = ''

test('optional 2FA: turn it on from the Security page', async ({ page }) => {
  const f = fixtures()
  await signIn(page, f.securityUsers.mfaUser.email)
  await expect(page).toHaveURL(/\/agency/)
  await page.goto('/security')
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Set up authenticator app' }).click()
  mfaSecret = (await page.locator('code').first().innerText()).trim()
  expect(mfaSecret).toMatch(/^[A-Z2-7]+=*$/)
  await page.getByLabel('6-digit code').fill(totp(mfaSecret))
  await page.getByRole('button', { name: 'Verify and turn on' }).click()
  await expect(page.getByText('Two-factor sign-in is on')).toBeVisible()
})

test('with 2FA on, the password alone only gets you to the code page', async ({ page }) => {
  const f = fixtures()
  await signIn(page, f.securityUsers.mfaUser.email)
  await expect(page).toHaveURL(/\/mfa$/)
  // Half signed in: the app itself stays closed.
  await page.goto('/agency/clients')
  await page.waitForLoadState('networkidle')
  await expect(page).toHaveURL(/\/mfa$/)

  await page.getByLabel('Code').fill('000000')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(/not correct/)).toBeVisible()

  await page.getByLabel('Code').fill(totp(mfaSecret))
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/agency/)
  await page.goto('/agency/clients')
  await page.waitForLoadState('networkidle')
  await expect(page).toHaveURL(/\/agency\/clients/)
})

test.describe('admin reset', () => {
  test.use(auth('agencyA'))

  test("an agency admin can reset a staff member's 2FA (lost phone)", async ({ page }) => {
    await page.goto('/agency/users')
    await page.waitForLoadState('networkidle')
    const row = page.getByRole('row', { name: /E2E MFA User/ })
    await row.getByRole('button', { name: 'Actions' }).click()
    await page.getByRole('menuitem', { name: /Reset two-factor/ }).click()
    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(page.getByText(/Two-factor sign-in reset for E2E MFA User/)).toBeVisible()
  })
})

test('after a reset, the password signs in again', async ({ page }) => {
  const f = fixtures()
  await signIn(page, f.securityUsers.mfaUser.email)
  await expect(page).toHaveURL(/\/agency/)
})

test('five wrong passwords lock the account for a while — even with the right one after', async ({ page }) => {
  const f = fixtures()
  for (let i = 0; i < 5; i++) {
    await signIn(page, f.securityUsers.lockout.email, 'Wrong-Password-1!')
    await expect(page.getByText('Invalid email or password.')).toBeVisible()
  }
  await signIn(page, f.securityUsers.lockout.email)
  await expect(page.getByText(/Too many attempts/)).toBeVisible()
  await expect(page).toHaveURL(/\/login/)
})

test('change password: the current one is checked, then the new one works', async ({ page, browser }) => {
  const f = fixtures()
  await signIn(page, f.securityUsers.pwUser.email)
  await expect(page).toHaveURL(/\/agency/)
  await page.goto('/security')
  await page.waitForLoadState('networkidle')

  await page.getByLabel('Current password').fill('Not-My-Password-1!')
  await page.getByLabel('New password').fill('Brand-New-Pass-42!')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Your current password is not correct.')).toBeVisible()

  await page.getByLabel('Current password').fill(PASSWORD)
  await page.getByLabel('New password').fill('Brand-New-Pass-42!')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed')).toBeVisible()

  const fresh = await (await browser.newContext()).newPage()
  await signIn(fresh, f.securityUsers.pwUser.email, 'Brand-New-Pass-42!')
  await expect(fresh).toHaveURL(/\/agency/)
})
