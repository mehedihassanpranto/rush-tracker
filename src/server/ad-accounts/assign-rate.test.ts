import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLiveTestEnv } from '@/test/live-env'

/**
 * Assigning or transferring an ad account sets its USD rate to the receiving
 * client's (migration 000057, owner request 2026-10-06) — before, a rate left
 * over from the previous client kept billing the new one. Live test against
 * staging with its own throwaway organization; skips without credentials.
 */
const creds = loadLiveTestEnv()
const SUFFIX = `ratetest-${Date.now()}`

describe.skipIf(!creds)('assign / transfer set the account rate to the client rate', () => {
  let admin: SupabaseClient
  let org = ''
  let accountId = ''
  const clients: Record<'a' | 'b' | 'none', string> = { a: '', b: '', none: '' }

  const accountRate = async () => {
    const { data } = await admin.from('ad_accounts').select('usd_rate').eq('id', accountId).single()
    return Number((data as { usd_rate: number }).usd_rate)
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: o, error: oErr } = await admin
      .from('organizations')
      .insert({ name: `ZZ Rate ${SUFFIX}`, subscription_status: 'active' })
      .select('id')
      .single()
    if (oErr) throw new Error(oErr.message)
    org = o.id

    const { data: c, error: cErr } = await admin
      .from('clients')
      .insert([
        { name: `ZZ Rate A ${SUFFIX}`, organization_id: org, segment: 'postpaid', usd_rate: 122 },
        { name: `ZZ Rate B ${SUFFIX}`, organization_id: org, segment: 'postpaid', usd_rate: 125.5 },
        { name: `ZZ Rate None ${SUFFIX}`, organization_id: org, segment: 'postpaid', usd_rate: 0 },
      ])
      .select('id, name')
    if (cErr) throw new Error(cErr.message)
    clients.a = c!.find((x) => x.name.includes('Rate A'))!.id
    clients.b = c!.find((x) => x.name.includes('Rate B'))!.id
    clients.none = c!.find((x) => x.name.includes('Rate None'))!.id

    // Starts with a stale rate, as if left by an earlier client or an import.
    const { data: a, error: aErr } = await admin
      .from('ad_accounts')
      .insert({ name: `ZZ Rate Account ${SUFFIX}`, platform: 'META', organization_id: org, is_platform: false, usd_rate: 130 })
      .select('id')
      .single()
    if (aErr) throw new Error(aErr.message)
    accountId = a.id
  }, 30_000)

  afterAll(async () => {
    if (!admin) return
    await admin.from('ad_account_assignments').delete().eq('ad_account_id', accountId)
    await admin.from('audit_logs').delete().eq('organization_id', org)
    await admin.from('ad_accounts').delete().eq('id', accountId)
    await admin.from('clients').delete().eq('organization_id', org)
    await admin.from('organizations').delete().eq('id', org)
  }, 30_000)

  it('assign replaces the stale rate with the client rate and audits both', async () => {
    const { data: assignmentId, error } = await admin.rpc('assign_ad_account', {
      p_account_id: accountId,
      p_client_id: clients.a,
      p_actor: null,
      p_organization_id: org,
    })
    expect(error).toBeNull()
    expect(assignmentId).toBeTruthy()
    expect(await accountRate()).toBe(122)

    const { data: audit } = await admin
      .from('audit_logs')
      .select('new_values')
      .eq('entity_id', accountId)
      .eq('action', 'ACCOUNT_ASSIGNED')
      .single()
    expect(Number((audit as { new_values: Record<string, number> }).new_values.previous_usd_rate)).toBe(130)
    expect(Number((audit as { new_values: Record<string, number> }).new_values.usd_rate)).toBe(122)
  })

  it('transfer sets the receiving client rate', async () => {
    const { error } = await admin.rpc('transfer_ad_account', {
      p_account_id: accountId,
      p_to_client_id: clients.b,
      p_actor: null,
      p_organization_id: org,
    })
    expect(error).toBeNull()
    expect(await accountRate()).toBe(125.5)
  })

  it('a client without a rate leaves the account inheriting (0)', async () => {
    const { error } = await admin.rpc('transfer_ad_account', {
      p_account_id: accountId,
      p_to_client_id: clients.none,
      p_actor: null,
      p_organization_id: org,
    })
    expect(error).toBeNull()
    expect(await accountRate()).toBe(0)
  })
})
