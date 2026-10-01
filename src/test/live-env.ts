import { existsSync, readFileSync } from 'node:fs'

/**
 * Credentials for the live-database integration tests.
 *
 * THESE TESTS WRITE REAL ROWS (throwaway organizations, grants, ledger rows),
 * so they must only ever run against a disposable STAGING Supabase project —
 * never the one in `.env`, which is production. This loader therefore reads
 * `.env.test` (or the SUPABASE_TEST_* variables CI provides) and deliberately
 * never `.env`. With neither present the tests skip, which is the safe default.
 *
 * As a second line of defence it throws if the test URL equals the URL in
 * `.env`, so copying production values into `.env.test` by mistake fails loudly
 * instead of silently writing to production. See docs/STAGING.md.
 */
export type LiveTestEnv = {
  url: string
  /** Service-role key (alias of `serviceKey`, kept for older tests). */
  key: string
  serviceKey: string
  anonKey: string
}

const root = new URL('../../', import.meta.url)

function parseEnvFile(name: string): Record<string, string> {
  const file = new URL(name, root)
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return out
}

export function loadLiveTestEnv(): LiveTestEnv | null {
  const file = parseEnvFile('.env.test')
  const url =
    process.env.SUPABASE_TEST_URL ?? file.VITE_SUPABASE_URL ?? file.SUPABASE_URL
  const serviceKey =
    process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? file.SUPABASE_SERVICE_ROLE_KEY
  const anonKey =
    process.env.SUPABASE_TEST_ANON_KEY ?? file.VITE_SUPABASE_ANON_KEY
  if (!url || !serviceKey || !anonKey) return null

  const prod = parseEnvFile('.env')
  const prodUrl = prod.VITE_SUPABASE_URL ?? prod.SUPABASE_URL
  if (prodUrl && prodUrl.replace(/\/$/, '') === url.replace(/\/$/, '')) {
    throw new Error(
      'Refusing to run live tests: the test Supabase URL is the same as the one in .env (production). Point .env.test at the staging project.',
    )
  }
  return { url, key: serviceKey, serviceKey, anonKey }
}
