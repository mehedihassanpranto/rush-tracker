import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadLiveTestEnv } from '@/test/live-env'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * readDailySpend() against staging: PostgREST stops at 1000 rows, and a
 * month of an agency's accounts passes that (production: 34 × 31 days), so
 * it must page — and chunk long id lists. The service's admin client is the
 * STAGING one here, never whatever `.env` holds.
 */
vi.mock('@/lib/supabase/admin.server', async () => {
  const { loadLiveTestEnv: load } = await import('@/test/live-env')
  const c = load()
  const client = c ? createClient(c.url, c.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null
  return {
    getSupabaseAdminClient: () => {
      if (!client) throw new Error('no staging credentials')
      return client
    },
  }
})
vi.mock('./meta.server', () => ({ fetchMetaDailySpend: vi.fn() }))

const { readDailySpend } = await import('./meta-daily-spend.service')

const creds = loadLiveTestEnv()
const SUFFIX = `mdstest-${Date.now()}`

describe.skipIf(!creds)('readDailySpend (000067)', () => {
  let admin: SupabaseClient
  let org = ''
  let account = ''

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: o, error } = await admin
      .from('organizations')
      .insert({ name: `ZZ MDS ${SUFFIX}`, subscription_status: 'active' })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    org = o.id
    const { data: a, error: aErr } = await admin
      .from('ad_accounts')
      .insert({ name: `ZZ MDS acct ${SUFFIX}`, platform: 'META', organization_id: org, is_platform: false, external_account_id: `act_${SUFFIX}` })
      .select('id')
      .single()
    if (aErr) throw new Error(aErr.message)
    account = a.id
    // 1,250 consecutive days from 2020-01-01, $1 each.
    const rows = Array.from({ length: 1250 }, (_, i) => ({
      ad_account_id: account,
      spend_date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      spend: 1,
      currency: 'USD',
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error: sErr } = await admin.from('meta_daily_spend').insert(rows.slice(i, i + 500))
      if (sErr) throw new Error(sErr.message)
    }
  }, 60_000)

  afterAll(async () => {
    if (!admin) return
    if (account) await admin.from('ad_accounts').delete().eq('id', account) // spend cascades
    if (org) await admin.from('organizations').delete().eq('id', org)
  }, 60_000)

  it('returns every row past the 1000-row cap, across id chunks', async () => {
    // 150 ids → two chunks; the real account sits in the second.
    const ids = [...Array.from({ length: 149 }, () => crypto.randomUUID()), account]
    const rows = await readDailySpend(ids, '2020-01-01', '2030-12-31')
    expect(rows).toHaveLength(1250)
    expect(new Set(rows.map((r) => r.spend_date)).size).toBe(1250)
    expect(rows.reduce((s, r) => s + Number(r.spend), 0)).toBe(1250)
  })

  it('keeps to the date range', async () => {
    const rows = await readDailySpend([account], '2020-01-01', '2020-01-31')
    expect(rows.map((r) => r.spend_date)).toEqual(
      Array.from({ length: 31 }, (_, i) => `2020-01-${String(i + 1).padStart(2, '0')}`),
    )
  })
})
