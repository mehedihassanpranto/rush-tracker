import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadLiveTestEnv } from '@/test/live-env'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Row-level isolation between agencies, enforced by RLS, for every
 * organization-scoped table that can be seeded with a few columns.
 *
 * Most app reads go through the service-role server layer (which bypasses RLS
 * and filters in code — covered by the e2e suite), so RLS is the second wall:
 * if a server fn ever forgets its organization filter, or a signed-in user
 * reaches the database directly with their own session, these policies are what
 * stop one agency reading another's rows. This test signs in as real users of
 * two throwaway agencies through the anon key (RLS applies) and reads every
 * table.
 *
 * It is deliberately NOT vacuous: each table is seeded for BOTH agencies, and
 * the test first asserts the user can read their own rows, so a policy that
 * blanket-denies cannot pass.
 */
const creds = loadLiveTestEnv()
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }
const RUN = `rls${Date.now().toString(36)}`
const PASSWORD = 'Rls-Iso-Pass-123!'

// table -> a column carrying the organization, for the assertion
const TABLES = [
  'clients',
  'client_memberships',
  'ad_accounts',
  'ledger_entries',
  'payments',
  'payment_requests',
  'adjustments',
  'attachments',
  'audit_logs',
  'notifications',
  'employees',
  'client_employees',
  'exchange_rates',
  'usd_margin_entries',
  'user_profiles',
] as const

type Side = { org: string; adminId: string; adminEmail: string; clientUserId: string; clientUserEmail: string; clientId: string }

describe.skipIf(!creds)('RLS cross-agency isolation', () => {
  let admin: SupabaseClient
  const sides: Record<'A' | 'B', Side> = {} as never
  const asAdmin: Partial<Record<'A' | 'B', SupabaseClient>> = {}
  let clientUserOfA: SupabaseClient
  const orgIds: string[] = []
  const userIds: string[] = []

  async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string) {
    const { data, error } = await p
    if (error || data == null) throw new Error(`${what}: ${error?.message ?? 'no data'}`)
    return data as NonNullable<T>
  }

  async function seedSide(label: 'A' | 'B', roles: Array<{ id: string; key: string }>): Promise<Side> {
    const org = (await must(
      admin.from('organizations').insert({ name: `ZZ RLS ${label} ${RUN}`, subscription_status: 'active' }).select('id').single(),
      'org',
    )).id
    orgIds.push(org)
    const mk = async (tag: string) => {
      const email = `rls-${tag}-${label}-${RUN}@example.test`
      const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
      if (error || !data.user) throw new Error(`createUser: ${error?.message}`)
      userIds.push(data.user.id)
      return { id: data.user.id, email }
    }
    const a = await mk('admin')
    const cu = await mk('client')
    const superAdmin = roles.find((r) => r.key === 'SUPER_ADMIN')!.id
    await must(admin.from('user_profiles').update({ organization_id: org, role_id: superAdmin }).eq('user_id', a.id).select('user_id'), 'admin profile')
    await must(admin.from('user_profiles').update({ organization_id: org }).eq('user_id', cu.id).select('user_id'), 'client profile')

    const clientId = (await must(
      admin.from('clients').insert({ name: `ZZ RLS Client ${label} ${RUN}`, organization_id: org, segment: 'postpaid' }).select('id').single(),
      'client',
    )).id
    const emp = (await must(
      admin.from('employees').insert({ name: `ZZ RLS Emp ${label}`, organization_id: org }).select('id').single(),
      'employee',
    )).id
    const ins = (table: string, row: Record<string, unknown>) =>
      must(admin.from(table).insert({ organization_id: org, ...row }).select('*'), `seed ${table}`)
    await ins('client_memberships', { user_id: cu.id, client_id: clientId })
    await ins('ad_accounts', { name: `ZZ RLS Account ${label} ${RUN}`, platform: 'META', is_platform: false, usd_rate: 0 })
    await ins('ledger_entries', { client_id: clientId, type: 'ADJUSTMENT_DEBIT', debit_bdt: 10 })
    await ins('payments', { client_id: clientId, amount_bdt: 10 })
    await ins('payment_requests', { client_id: clientId, requested_amount_bdt: 10 })
    await ins('adjustments', { client_id: clientId, type: 'ADD_DUE', amount_bdt: 10, reason: 'rls test' })
    await ins('attachments', { entity_type: 'TEST', entity_id: RUN, storage_bucket: 'proofs', storage_path: `rls/${label}/${RUN}` })
    await ins('audit_logs', { action: 'RLS_TEST', entity_type: 'TEST', actor_user_id: a.id })
    await ins('notifications', { user_id: a.id, type: 'TEST', title: `rls ${label}` })
    await ins('client_employees', { client_id: clientId, employee_id: emp })
    await ins('exchange_rates', { rate: 100 })
    await ins('usd_margin_entries', { transaction_date: '2026-01-01', usd_amount: 1, buying_rate: 1, selling_rate: 2 })
    return { org, adminId: a.id, adminEmail: a.email, clientUserId: cu.id, clientUserEmail: cu.email, clientId }
  }

  async function signIn(email: string): Promise<SupabaseClient> {
    const c = createClient(creds!.url, creds!.anonKey, noSession)
    const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD })
    if (error) throw new Error(`sign in ${email}: ${error.message}`)
    return c
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    const roles = await must(admin.from('roles').select('id, key'), 'roles')
    sides.A = await seedSide('A', roles)
    sides.B = await seedSide('B', roles)
    asAdmin.A = await signIn(sides.A.adminEmail)
    asAdmin.B = await signIn(sides.B.adminEmail)
    clientUserOfA = await signIn(sides.A.clientUserEmail)
  }, 90_000)

  afterAll(async () => {
    if (!admin) return
    for (const t of ['notifications', 'audit_logs', 'adjustments', 'ledger_entries', 'payments', 'payment_requests', 'attachments', 'client_employees', 'usd_margin_entries', 'exchange_rates', 'ad_accounts', 'client_memberships', 'employees', 'clients']) {
      await admin.from(t).delete().in('organization_id', orgIds)
    }
    await admin.from('user_profiles').delete().in('user_id', userIds)
    for (const id of userIds) await admin.auth.admin.deleteUser(id)
    await admin.from('organizations').delete().in('id', orgIds)
  }, 60_000)

  for (const side of ['A', 'B'] as const) {
    const other = side === 'A' ? 'B' : 'A'
    describe(`agency ${side}'s admin`, () => {
      for (const table of TABLES) {
        it(`reads its own ${table} rows and none of agency ${other}'s`, async () => {
          const { data, error } = await asAdmin[side]!.from(table).select('organization_id')
          expect(error, `${table}: ${error?.message}`).toBeNull()
          const orgs = (data ?? []).map((r: { organization_id: string }) => r.organization_id)
          // non-vacuous: the policy lets them see their own seeded rows…
          expect(orgs, `${table} should return the agency's own rows`).toContain(sides[side].org)
          // …and it never returns another agency's.
          expect(orgs.every((o) => o === sides[side].org), `${table} leaked: ${[...new Set(orgs)].join(',')}`).toBe(true)
        })
      }
    })
  }

  it("agency A's admin cannot read agency B's client by id", async () => {
    const { data } = await asAdmin.A!.from('clients').select('id').eq('id', sides.B.clientId)
    expect(data).toEqual([])
  })

  it("a client login of agency A sees only its own client's money rows", async () => {
    for (const table of ['ledger_entries', 'payments', 'payment_requests', 'adjustments'] as const) {
      const { data, error } = await clientUserOfA.from(table).select('client_id, organization_id')
      expect(error, `${table}: ${error?.message}`).toBeNull()
      for (const r of (data ?? []) as Array<{ client_id: string; organization_id: string }>) {
        expect(r.client_id, `${table} row for another client`).toBe(sides.A.clientId)
        expect(r.organization_id).toBe(sides.A.org)
      }
    }
  })

  it("no signed-in user can read agency app_settings or the organizations table", async () => {
    for (const c of [asAdmin.A!, clientUserOfA]) {
      for (const table of ['app_settings', 'platform_settings', 'organizations']) {
        const { data } = await c.from(table).select('*')
        expect(data ?? [], `${table} readable by a tenant user`).toEqual([])
      }
    }
  })
})
