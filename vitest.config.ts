import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Standalone Vitest config (Phase 8, spec §85). Deliberately does NOT load the
 * TanStack Start / Nitro Vite plugins — these are pure unit tests over the
 * decimal-safe money math, RBAC permission logic, auth helpers, CSV export and
 * ledger running-balance. DB-dependent business rules (limit approval, payment
 * approval, transfer, reconciliation, concurrency, cross-client denial) are
 * exercised against a live Supabase project per docs/TESTING.md.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
