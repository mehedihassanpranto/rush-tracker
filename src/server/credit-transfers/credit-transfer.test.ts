import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLiveTestEnv } from '@/test/live-env'

/**
 * Credit transfers (migration 000058) against staging: the database rules
 * that keep a transfer safe — same client only, never more than the source's
 * limit, pool accounts only executed by a platform admin, one pending
 * transfer per account, nothing half-applied. Own throwaway org; skips
 * without credentials.
 */
const creds = loadLiveTestEnv()
const SUFFIX = `cttest-${Date.now()}`

describe.skipIf(!creds)('credit transfers — database rules', () => {
  let admin: SupabaseClient
  let org = ''
  let clientX = ''
  let clientY = ''
  let platformAdminId = ''
  const acc: Record<'a' | 'b' | 'c' | 'pool', string> = { a: '', b: '', c: '', pool: '' }

  const limit = async (id: string) => {
    const { data } = await admin.from('ad_accounts').select('current_limit_usd').eq('id', id).single()
    return Number((data as { current_limit_usd: number }).current_limit_usd)
  }
  const create = (source: string, destination: string, amount: number, execute: boolean, actor: string | null = null) =>
    admin.rpc('create_credit_transfer', {
      p_organization_id: org,
      p_source: source,
      p_destination: destination,
      p_amount: amount,
      p_note: 'test',
      p_actor: actor,
      p_execute: execute,
    })

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: o, error: oErr } = await admin
      .from('organizations')
      .insert({ name: `ZZ CT ${SUFFIX}`, subscription_status: 'active' })
      .select('id')
      .single()
    if (oErr) throw new Error(oErr.message)
    org = o.id

    const { data: c, error: cErr } = await admin
      .from('clients')
      .insert([
        { name: `ZZ CT X ${SUFFIX}`, organization_id: org, segment: 'postpaid' },
        { name: `ZZ CT Y ${SUFFIX}`, organization_id: org, segment: 'postpaid' },
      ])
      .select('id, name')
    if (cErr) throw new Error(cErr.message)
    clientX = c!.find((r) => r.name.includes('CT X'))!.id
    clientY = c!.find((r) => r.name.includes('CT Y'))!.id

    const mk = (name: string, lim: number, pool = false) => ({
      name: `ZZ CT ${name} ${SUFFIX}`,
      platform: 'META',
      current_limit_usd: lim,
      usd_rate: 0,
      status: 'ACTIVE',
      is_platform: pool,
      organization_id: pool ? null : org,
    })
    const { data: a, error: aErr } = await admin
      .from('ad_accounts')
      .insert([mk('A', 500), mk('B', 100), mk('C', 100), mk('Pool', 50, true)])
      .select('id, name')
    if (aErr) throw new Error(aErr.message)
    const find = (n: string) => a!.find((r) => r.name.startsWith(`ZZ CT ${n} `))!.id
    acc.a = find('A')
    acc.b = find('B')
    acc.c = find('C')
    acc.pool = find('Pool')

    const g = await admin.from('platform_account_grants').insert({ ad_account_id: acc.pool, organization_id: org })
    if (g.error) throw new Error(g.error.message)
    const assign = (id: string, client: string, opening: number) => ({
      ad_account_id: id, client_id: client, opening_limit_usd: opening, organization_id: org,
    })
    const s = await admin.from('ad_account_assignments').insert([
      assign(acc.a, clientX, 500), assign(acc.b, clientX, 100),
      assign(acc.pool, clientX, 50), assign(acc.c, clientY, 100),
    ])
    if (s.error) throw new Error(s.error.message)

    const { data: u, error: uErr } = await admin.auth.admin.createUser({
      email: `zz-ct-${Date.now()}@example.invalid`,
      password: `Zz-${Math.random().toString(36).slice(2)}-9aA!`,
      email_confirm: true,
    })
    if (uErr) throw new Error(uErr.message)
    platformAdminId = u.user.id
    const p = await admin.from('user_profiles').update({ is_platform_admin: true }).eq('user_id', platformAdminId)
    if (p.error) throw new Error(p.error.message)
  }, 60_000)

  afterAll(async () => {
    if (!admin) return
    const ids = Object.values(acc).filter(Boolean)
    await admin.from('credit_transfers').delete().eq('organization_id', org)
    await admin.from('audit_logs').delete().eq('organization_id', org)
    await admin.from('ad_account_assignments').delete().in('ad_account_id', ids)
    await admin.from('platform_account_grants').delete().eq('ad_account_id', acc.pool)
    await admin.from('ad_accounts').delete().in('id', ids)
    await admin.from('clients').delete().eq('organization_id', org)
    await admin.from('organizations').delete().eq('id', org)
    if (platformAdminId) await admin.auth.admin.deleteUser(platformAdminId)
  }, 60_000)

  it('moves limit between two agency-owned accounts of one client, recording before/after', async () => {
    const { data, error } = await create(acc.a, acc.b, 200, true)
    expect(error).toBeNull()
    expect((data as { status: string }).status).toBe('COMPLETED')
    expect(await limit(acc.a)).toBe(300)
    expect(await limit(acc.b)).toBe(300)

    const { data: row } = await admin
      .from('credit_transfers')
      .select('source_limit_before, source_limit_after, destination_limit_before, destination_limit_after')
      .eq('id', (data as { id: string }).id)
      .single()
    expect(row).toMatchObject({
      source_limit_before: 500, source_limit_after: 300,
      destination_limit_before: 100, destination_limit_after: 300,
    })
    const { count } = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', org)
      .in('action', ['CREDIT_TRANSFERRED_OUT', 'CREDIT_TRANSFERRED_IN'])
    expect(count).toBe(2)
  })

  it('refuses a different client, more than the limit, and the same account', async () => {
    expect((await create(acc.a, acc.c, 10, true)).error?.message).toContain('DIFFERENT_CLIENTS')
    expect((await create(acc.b, acc.a, 1000, true)).error?.message).toContain('INSUFFICIENT_LIMIT')
    expect((await create(acc.a, acc.a, 10, true)).error?.message).toContain('SAME_ACCOUNT')
    expect(await limit(acc.a)).toBe(300)
  })

  it("won't let a non-platform actor execute a pool transfer, and leaves nothing behind", async () => {
    const { error } = await create(acc.a, acc.pool, 20, true, null)
    expect(error?.message).toContain('PLATFORM_REVIEW_REQUIRED')
    expect(await limit(acc.a)).toBe(300)
    expect(await limit(acc.pool)).toBe(50)
    const { count } = await admin
      .from('credit_transfers')
      .select('id', { count: 'exact', head: true })
      .eq('destination_account_id', acc.pool)
    expect(count).toBe(0)
  })

  it('a pool request waits for the platform, blocks a second one, and only a platform admin applies it', async () => {
    const { data, error } = await create(acc.a, acc.pool, 20, false)
    expect(error).toBeNull()
    const id = (data as { id: string; status: string }).id
    expect((data as { status: string }).status).toBe('PENDING_PLATFORM_REVIEW')
    expect(await limit(acc.a)).toBe(300)

    expect((await create(acc.b, acc.a, 5, true)).error?.message).toContain('PENDING_TRANSFER')

    const refused = await admin.rpc('apply_credit_transfer', { p_transfer_id: id, p_actor: null })
    expect(refused.error?.message).toContain('PLATFORM_REVIEW_REQUIRED')

    const applied = await admin.rpc('apply_credit_transfer', { p_transfer_id: id, p_actor: platformAdminId })
    expect(applied.error).toBeNull()
    expect(await limit(acc.a)).toBe(280)
    expect(await limit(acc.pool)).toBe(70)

    const again = await admin.rpc('apply_credit_transfer', { p_transfer_id: id, p_actor: platformAdminId })
    expect(again.error?.message).toContain('NOT_PENDING')
  })

  it('refuses while a limit request is pending on either account', async () => {
    const lr = await admin.from('limit_requests').insert({
      client_id: clientX, ad_account_id: acc.b, organization_id: org,
      assignment_id: (await admin.from('ad_account_assignments').select('id').eq('ad_account_id', acc.b).eq('status', 'ACTIVE').single()).data!.id,
      opening_balance_usd: 300, requested_amount_usd: 10, default_usd_rate: 120,
      expected_new_limit_usd: 310, status: 'PENDING', segment: 'postpaid', total_cost_bdt: 1200,
    }).select('id').single()
    expect(lr.error).toBeNull()
    expect((await create(acc.a, acc.b, 5, true)).error?.message).toContain('PENDING_LIMIT_REQUEST')
    await admin.from('limit_requests').delete().eq('id', lr.data!.id)
  })
})
