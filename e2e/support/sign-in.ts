import type { Page } from '@playwright/test'
import { PASSWORD } from './seed'

/** Signs in through the real login form (no injected session), like a person. */
export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login')
  // Wait for the app's JS, so the form is handled by the app rather than
  // the browser's native submit.
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}
