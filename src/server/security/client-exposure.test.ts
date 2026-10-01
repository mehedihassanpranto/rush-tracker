import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadLiveTestEnv } from '@/test/live-env'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * What can the PUBLIC anon key — which ships in the browser bundle — and a
 * signed-in user reach directly in the database?
 *
 * Added after finding that every "service_role only" RPC was in fact callable
 * by anyone: Supabase's default privileges grant EXECUTE on new functions to
 * anon/authenticated, and the migrations only revoked from PUBLIC. That
 * exposed reset_all_data(org) (org zero's id is a fixed, well-known value),
 * approve_payment, find_auth_user_by_email and more. See migrations 000050–52.
 *
 * Asserts against a real database via client_exposure_report(), so it checks
 * actual privileges rather than migration text. A function added later that
 * forgets to lock itself down fails here.
 */
const creds = loadLiveTestEnv()
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

// Read-only identity helpers that RLS policies call. They must stay callable
// (a policy runs as the querying role) and reveal nothing about other tenants.
const POLICY_HELPERS = [
  'current_org_id',
  'has_permission',
  'is_admin',
  'is_client_member',
  'is_org_active',
  'is_platform_admin',
]

const ORG_ZERO = '00000000-0000-0000-0000-000000000001'
const NIL = '00000000-0000-0000-0000-0000000000ff'

describe.skipIf(!creds)('public key / signed-in user exposure', () => {
  let admin: SupabaseClient
  let anon: SupabaseClient
  let user: SupabaseClient
  let userId = ''
  const email = `exposure-${Date.now()}@example.test`
  const password = 'Exposure-Pass-123!'

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    anon = createClient(creds!.url, creds!.anonKey, noSession)
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw new Error(error.message)
    userId = data.user.id
    user = createClient(creds!.url, creds!.anonKey, noSession)
    const { error: signInErr } = await user.auth.signInWithPassword({ email, password })
    if (signInErr) throw new Error(signInErr.message)
  }, 30_000)

  afterAll(async () => {
    if (admin && userId) await admin.auth.admin.deleteUser(userId)
  }, 30_000)

  it('exposes only the RLS helper functions, and no table writes, to anon/authenticated', async () => {
    const { data, error } = await admin.rpc('client_exposure_report')
    expect(error).toBeNull()
    const rows = (data ?? []) as Array<{ kind: string; name: string; role_name: string; privilege: string }>

    const functions = rows.filter((r) => r.kind === 'function')
    expect([...new Set(functions.map((r) => r.name))].sort()).toEqual([...POLICY_HELPERS].sort())
    // …and the report itself is not one of them.
    expect(functions.map((r) => r.name)).not.toContain('client_exposure_report')

    const tableWrites = rows.filter((r) => r.kind === 'table')
    expect(tableWrites, `table write grants: ${JSON.stringify(tableWrites)}`).toEqual([])
  })

  it('cannot call the exposure report itself', async () => {
    for (const c of [anon, user]) {
      const { error } = await c.rpc('client_exposure_report')
      expect(error?.code).toBe('42501')
    }
  })

  // Real calls with the right argument names, so a denial can only be a
  // privilege denial (a wrong-args call returns PGRST202 whether or not it's
  // executable, which would prove nothing).
  const privileged: Array<[string, () => Record<string, unknown>]> = [
    ['reset_all_data', () => ({ p_organization_id: ORG_ZERO })],
    ['approve_payment', () => ({ p_payment_id: NIL, p_actor: NIL, p_organization_id: ORG_ZERO })],
    ['all_client_dues', () => ({ p_organization_id: ORG_ZERO })],
    ['total_outstanding_due', () => ({ p_organization_id: ORG_ZERO })],
    ['find_auth_user_by_email', () => ({ p_email: email })],
    ['client_financials', () => ({ p_client_id: NIL })],
  ]

  for (const [fn, args] of privileged) {
    it(`${fn} is denied to anon and to a signed-in user`, async () => {
      for (const [who, c] of [['anon', anon], ['authenticated', user]] as const) {
        const { error } = await c.rpc(fn, args())
        expect(error?.code, `${who} calling ${fn}`).toBe('42501')
      }
    })
  }

  it('anon and authenticated cannot write to a table directly', async () => {
    for (const c of [anon, user]) {
      const { error } = await c.from('clients').insert({ name: 'ZZ should never exist', segment: 'postpaid' })
      expect(error?.code).toBe('42501')
    }
  })

  it('a signed-in user still reads their own identity through the RLS helpers', async () => {
    const { error } = await user.rpc('is_admin')
    expect(error).toBeNull()
    const { error: profileErr } = await user.from('user_profiles').select('user_id').eq('user_id', userId)
    expect(profileErr).toBeNull()
  })
})
