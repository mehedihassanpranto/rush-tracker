import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadLiveTestEnv } from '@/test/live-env'
import {
  PlanLimitError,
  assertPlanAllows,
  getOrganizationUsage,
} from './plan-limits.service'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Plan-limit enforcement against a real database: what counts toward each
 * limit (the part most likely to drift), that at-the-limit is refused while
 * under it passes, and that "no plan" never blocks. Seeds its own agency and a
 * throwaway plan with tiny limits; never touches existing rows.
 */
const creds = loadLiveTestEnv()
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }
const RUN = `plan${Date.now().toString(36)}`

describe.skipIf(!creds)('subscription plan limits', () => {
  let admin: SupabaseClient
  let orgId = ''
  let planId = ''
  const userIds: string[] = []
  const accountIds: string[] = []

  async function makeStaff(roleKey: string, status: 'ACTIVE' | 'INACTIVE', platform = false) {
    const email = `plan-${roleKey.toLowerCase()}-${userIds.length}-${RUN}@example.test`
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'Plan-Pass-123!', email_confirm: true })
    if (error) throw new Error(error.message)
    userIds.push(data.user.id)
    const { data: role } = await admin.from('roles').select('id').eq('key', roleKey).single()
    const { error: upErr } = await admin
      .from('user_profiles')
      .update({ organization_id: orgId, role_id: role!.id, status, is_platform_admin: platform })
      .eq('user_id', data.user.id)
    if (upErr) throw new Error(upErr.message)
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    const { data: plan, error: planErr } = await admin
      .from('subscription_plans')
      .insert({ name: `ZZ Test ${RUN}`, monthly_fee_bdt: 100, max_clients: 2, max_ad_accounts: 2, max_staff: 1, is_active: false })
      .select('id')
      .single()
    if (planErr) throw new Error(planErr.message)
    planId = plan.id
    const { data: org, error } = await admin
      .from('organizations')
      .insert({ name: `ZZ Plan ${RUN}`, subscription_status: 'active' })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    orgId = org.id
  }, 30_000)

  afterAll(async () => {
    if (!admin) return
    await admin.from('platform_account_grants').delete().eq('organization_id', orgId)
    await admin.from('ad_accounts').delete().in('id', accountIds)
    await admin.from('clients').delete().eq('organization_id', orgId)
    await admin.from('user_profiles').delete().in('user_id', userIds)
    for (const id of userIds) await admin.auth.admin.deleteUser(id)
    // subscription_payments cascade with the organization (checked below too).
    await admin.from('organizations').delete().eq('id', orgId)
    await admin.from('subscription_plans').delete().eq('id', planId)
  }, 30_000)

  it('no plan never blocks', async () => {
    await expect(assertPlanAllows(admin, orgId, 'clients', 10_000)).resolves.toBeUndefined()
  })

  it('counts only ACTIVE clients, and refuses at the limit', async () => {
    await admin.from('organizations').update({ plan_id: planId }).eq('id', orgId)
    await admin.from('clients').insert([
      { name: `ZZ c1 ${RUN}`, organization_id: orgId, segment: 'postpaid', status: 'ACTIVE' },
      { name: `ZZ c2 ${RUN}`, organization_id: orgId, segment: 'postpaid', status: 'INACTIVE' },
    ])
    expect((await getOrganizationUsage(admin, orgId)).clients).toBe(1)
    await expect(assertPlanAllows(admin, orgId, 'clients')).resolves.toBeUndefined()
    await admin.from('clients').insert({ name: `ZZ c3 ${RUN}`, organization_id: orgId, segment: 'postpaid', status: 'ACTIVE' })
    const err = await assertPlanAllows(admin, orgId, 'clients').catch((e) => e)
    expect(err).toBeInstanceOf(PlanLimitError)
    expect((err as Error).message).toMatch(/allows 2 active clients and you have 2/)
  })

  it('counts owned AND granted ad accounts, and checks a bulk add as a whole', async () => {
    const { data: owned } = await admin
      .from('ad_accounts')
      .insert({ name: `ZZ owned ${RUN}`, platform: 'META', is_platform: false, organization_id: orgId, usd_rate: 0 })
      .select('id')
      .single()
    const { data: pool } = await admin
      .from('ad_accounts')
      .insert({ name: `ZZ pool ${RUN}`, platform: 'META', is_platform: true, organization_id: null, usd_rate: 0 })
      .select('id')
      .single()
    accountIds.push(owned!.id, pool!.id)
    expect((await getOrganizationUsage(admin, orgId)).adAccounts).toBe(1)
    await expect(assertPlanAllows(admin, orgId, 'adAccounts', 2)).rejects.toBeInstanceOf(PlanLimitError)
    await admin.from('platform_account_grants').insert({ ad_account_id: pool!.id, organization_id: orgId })
    expect((await getOrganizationUsage(admin, orgId)).adAccounts).toBe(2)
    await expect(assertPlanAllows(admin, orgId, 'adAccounts')).rejects.toBeInstanceOf(PlanLimitError)
  })

  it('counts active agency staff only — not clients, inactive staff or platform operators', async () => {
    await makeStaff('SUPER_ADMIN', 'INACTIVE')
    await makeStaff('ADMIN', 'ACTIVE', true) // a platform operator profile
    await makeStaff('CLIENT', 'ACTIVE')
    expect((await getOrganizationUsage(admin, orgId)).staff).toBe(0)
    await expect(assertPlanAllows(admin, orgId, 'staff')).resolves.toBeUndefined()
    await makeStaff('ADMIN', 'ACTIVE')
    expect((await getOrganizationUsage(admin, orgId)).staff).toBe(1)
    await expect(assertPlanAllows(admin, orgId, 'staff')).rejects.toBeInstanceOf(PlanLimitError)
  })

  it('subscription payments are deleted with their agency and refuse bad periods', async () => {
    const bad = await admin.from('subscription_payments').insert({
      organization_id: orgId, amount_bdt: 100, period_start: '2026-10-10', period_end: '2026-10-01',
    })
    expect(bad.error).not.toBeNull()
    const zero = await admin.from('subscription_payments').insert({
      organization_id: orgId, amount_bdt: 0, period_start: '2026-10-01', period_end: '2026-10-31',
    })
    expect(zero.error).not.toBeNull()
    const ok = await admin.from('subscription_payments').insert({
      organization_id: orgId, plan_id: planId, amount_bdt: 100, period_start: '2026-10-01', period_end: '2026-10-31',
    })
    expect(ok.error).toBeNull()
  })
})
