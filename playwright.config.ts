import { defineConfig } from '@playwright/test'
import { loadE2EEnv } from './e2e/support/env'

/**
 * e2e runs the real app against the STAGING Supabase project only (see
 * docs/STAGING.md). The dev server is started here with explicit staging
 * credentials in process.env — which beats anything in `.env` — and with the
 * production Meta/Telegram/cron secrets from `.env` overridden by inert
 * values, so a test run can never reach the real Business Portfolio or bots.
 */
const env = loadE2EEnv()
const PORT = 3100
const INERT = 'e2e-disabled'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: `npx vite dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: env.url,
      VITE_SUPABASE_ANON_KEY: env.anonKey,
      SUPABASE_URL: env.url,
      SUPABASE_ANON_KEY: env.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: env.serviceKey,
      META_SYSTEM_USER_TOKEN: INERT,
      META_BUSINESS_ID: '0',
      CRON_SECRET: INERT,
      TELEGRAM_BOT_TOKEN: INERT,
      TELEGRAM_PLATFORM_BOT_TOKEN: INERT,
      TELEGRAM_WEBHOOK_SECRET: INERT,
      TELEGRAM_CHAT_ID: '0',
    },
  },
})
