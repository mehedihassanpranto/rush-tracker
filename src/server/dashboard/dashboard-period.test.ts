import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadLiveTestEnv } from '@/test/live-env'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Dashboard period figures (migration 000067) against staging:
 * agency_daily_totals() groups the ledger by ASIA/DHAKA day (an entry at
 * 00:30 Dhaka belongs to that day, though it is still the day before in UTC),
 * only for the asked organization; meta_daily_spend goes with its ad account.
 */
const creds = loadLiveTestEnv()
const SUFFIX = `dptest-${Date.now()}`
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

describe.skipIf(!creds)('dashboard period totals (000067)', () => {
  let admin: SupabaseClient
  let org = ''
  let other = ''
  let client = ''
  let otherClient = ''
  let account = ''

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    const { data: orgs, error } = await admin
      .from('organizations')
      .insert([
        { name: `ZZ DP ${SUFFIX}`, subscription_status: 'active' },
        { name: `ZZ DP other ${SUFFIX}`, subscription_status: 'active' },
      ])
      .select('id, name')
    if (error) throw new Error(error.message)
    org = orgs!.find((o) => !o.name.includes('other'))!.id
    other = orgs!.find((o) => o.name.includes('other'))!.id
    const { data: cs } = await admin
      .from('clients')
      .insert([
        { name: `ZZ DP client ${SUFFIX}`, organization_id: org, segment: 'postpaid' },
        { name: `ZZ DP other client ${SUFFIX}`, organization_id: other, segment: 'postpaid' },
      ])
      .select('id, organization_id')
    client = cs!.find((c) => c.organization_id === org)!.id
    otherClient = cs!.find((c) => c.organization_id === other)!.id
    const row = (c: string, o: string, type: string, at: string, usd: number | null, dr: number, cr: number) => ({
      client_id: c, organization_id: o, type, created_at: at, usd_amount: usd, debit_bdt: dr, credit_bdt: cr,
      reference_type: type === 'PAYMENT' ? 'PAYMENT' : 'LIMIT_REQUEST', description: SUFFIX,
    })
    const { error: lErr } = await admin.from('ledger_entries').insert([
      // 2026-10-22 23:30 Dhaka (17:30 UTC) → the 22nd.
      row(client, org, 'LIMIT_APPROVAL', '2026-10-22T17:30:00Z', 100, 13000, 0),
      // 2026-10-23 00:30 Dhaka (still 18:30 UTC on the 22nd) → the 23rd.
      row(client, org, 'LIMIT_APPROVAL', '2026-10-22T18:30:00Z', 40, 5200, 0),
      row(client, org, 'PAYMENT', '2026-10-23T04:00:00Z', null, 0, 9000),
      // Another agency's money never shows up.
      row(otherClient, other, 'PAYMENT', '2026-10-23T04:00:00Z', null, 0, 77777),
    ])
    if (lErr) throw new Error(lErr.message)
    const { data: a } = await admin
      .from('ad_accounts')
      .insert({ name: `ZZ DP acct ${SUFFIX}`, platform: 'META', organization_id: org, is_platform: false, external_account_id: `act_${SUFFIX}` })
      .select('id')
      .single()
    account = a!.id
  }, 60_000)

  afterAll(async () => {
    if (!admin) return
    await admin.from('ledger_entries').delete().in('client_id', [client, otherClient].filter(Boolean))
    if (account) await admin.from('ad_accounts').delete().eq('id', account)
    await admin.from('clients').delete().in('id', [client, otherClient].filter(Boolean))
    await admin.from('organizations').delete().in('id', [org, other].filter(Boolean))
  }, 60_000)

  it('groups approvals and payments by Asia/Dhaka day, for this agency only', async () => {
    const { data, error } = await admin.rpc('agency_daily_totals', { p_organization_id: org, p_from: '2026-10-22', p_to: '2026-10-23' })
    expect(error).toBeNull()
    const byDay = Object.fromEntries((data as Array<Record<string, unknown>>).map((r) => [
      r.day,
      [Number(r.approved_limit_usd), Number(r.approved_billing_bdt), Number(r.collection_bdt)],
    ]))
    expect(byDay).toEqual({
      '2026-10-22': [100, 13000, 0],
      '2026-10-23': [40, 5200, 9000],
    })
  })

  it('stores spend per account per day, and drops it with the account', async () => {
    const { error } = await admin.from('meta_daily_spend').upsert([
      { ad_account_id: account, spend_date: '2026-10-22', spend: 12.5, currency: 'USD' },
      { ad_account_id: account, spend_date: '2026-10-23', spend: 0, currency: 'USD' },
    ])
    expect(error).toBeNull()
    // A refresh overwrites a day, never duplicates it.
    await admin.from('meta_daily_spend').upsert({ ad_account_id: account, spend_date: '2026-10-23', spend: 3.25, currency: 'USD' })
    const { data } = await admin.from('meta_daily_spend').select('spend_date, spend').eq('ad_account_id', account).order('spend_date')
    expect(data!.map((r) => [r.spend_date, Number(r.spend)])).toEqual([['2026-10-22', 12.5], ['2026-10-23', 3.25]])
    await admin.from('ad_accounts').delete().eq('id', account)
    account = ''
    const { count } = await admin.from('meta_daily_spend').select('*', { count: 'exact', head: true }).eq('spend_date', '2026-10-22').eq('spend', 12.5)
    expect(count).toBe(0)
  })

  it('the public key reaches neither', async () => {
    const anon = createClient(creds!.url, creds!.anonKey, noSession)
    expect((await anon.from('meta_daily_spend').select('*').limit(1)).data ?? []).toEqual([])
    expect((await anon.rpc('agency_daily_totals', { p_organization_id: org, p_from: '2026-10-22', p_to: '2026-10-23' })).error).not.toBeNull()
  })
})
