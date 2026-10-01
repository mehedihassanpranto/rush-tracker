import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Staging credentials for the e2e suite. Reads `.env.test` (or the
 * SUPABASE_TEST_* variables CI provides) and NEVER `.env`; refuses to run if
 * the URL equals the one in `.env` (production). Same guard as
 * src/test/live-env.ts — duplicated rather than imported because Playwright
 * does not resolve the app's `@/` alias.
 */
export type E2EEnv = { url: string; anonKey: string; serviceKey: string }

function parse(name: string): Record<string, string> {
  const file = fileURLToPath(new URL(`../../${name}`, import.meta.url))
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

export function loadE2EEnv(): E2EEnv {
  const f = parse('.env.test')
  const url = process.env.SUPABASE_TEST_URL ?? f.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? f.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? f.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceKey) {
    throw new Error('e2e needs staging credentials: fill .env.test (see docs/STAGING.md) or set SUPABASE_TEST_* variables.')
  }
  const prod = parse('.env')
  const prodUrl = prod.VITE_SUPABASE_URL ?? prod.SUPABASE_URL
  if (prodUrl && prodUrl.replace(/\/$/, '') === url.replace(/\/$/, '')) {
    throw new Error('Refusing to run e2e: the test Supabase URL is production (.env). Point .env.test at staging.')
  }
  return { url, anonKey, serviceKey }
}
