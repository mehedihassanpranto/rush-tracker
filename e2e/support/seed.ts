import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { E2EEnv } from './env'

/**
 * Throwaway fixtures for the e2e suite, created on STAGING only:
 *   two agencies (A, B) each with a SUPER_ADMIN login, one client and one
 *   owned ad account; a client login under A's client; a platform admin; and a
 *   suspended agency with a login. Everything is named with RUN and deleted by
 *   teardown(), in FK order, so a crashed run leaves nothing a re-run trips on.
 */
export const BASE_URL = 'http://localhost:3100'
export const PASSWORD = 'E2e-Pass-1234!'
export const ORG_ZERO = '00000000-0000-0000-0000-000000000001'

export type Role = 'platform' | 'agencyA' | 'agencyB' | 'client' | 'suspended'
export type Fixtures = {
  run: string
  orgA: string
  orgB: string
  orgS: string
  clientA: string
  clientB: string
  clientAName: string
  clientBName: string
  accountAName: string
  accountBName: string
  users: Record<Role, { id: string; email: string }>
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

export function adminClient(env: E2EEnv): SupabaseClient {
  return createClient(env.url, env.serviceKey, noSession)
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await p
  if (error || data == null) throw new Error(`${what}: ${error?.message ?? 'no data'}`)
  return data
}

async function makeUser(admin: SupabaseClient, email: string, name: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: name },
  })
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`)
  return data.user.id
}

export async function seed(env: E2EEnv, run: string): Promise<Fixtures> {
  const admin = adminClient(env)
  const roles = await must(admin.from('roles').select('id, key'), 'roles')
  const roleId = (k: string) => roles.find((r) => r.key === k)!.id

  const orgs = await must(
    admin
      .from('organizations')
      .insert([
        { name: `ZZ E2E Agency A ${run}`, subscription_status: 'active' },
        { name: `ZZ E2E Agency B ${run}`, subscription_status: 'active' },
        { name: `ZZ E2E Suspended ${run}`, subscription_status: 'suspended' },
      ])
      .select('id, name'),
    'organizations',
  )
  const orgA = orgs.find((o) => o.name.includes('Agency A'))!.id
  const orgB = orgs.find((o) => o.name.includes('Agency B'))!.id
  const orgS = orgs.find((o) => o.name.includes('Suspended'))!.id

  const mk = (key: string) => `e2e-${key}-${run}@example.test`
  const users = {
    platform: { id: await makeUser(admin, mk('platform'), 'E2E Platform'), email: mk('platform') },
    agencyA: { id: await makeUser(admin, mk('agency-a'), 'E2E Agency A Admin'), email: mk('agency-a') },
    agencyB: { id: await makeUser(admin, mk('agency-b'), 'E2E Agency B Admin'), email: mk('agency-b') },
    client: { id: await makeUser(admin, mk('client'), 'E2E Client'), email: mk('client') },
    suspended: { id: await makeUser(admin, mk('suspended'), 'E2E Suspended Admin'), email: mk('suspended') },
  }

  // The signup trigger lands every new account in org zero as a CLIENT; an
  // agency admin needs an explicit organization AND role (see createOrganizationFn).
  const setProfile = (id: string, patch: Record<string, unknown>) =>
    must(admin.from('user_profiles').update(patch).eq('user_id', id).select('user_id'), 'profile')
  await setProfile(users.platform.id, { is_platform_admin: true }) // stays org zero + CLIENT, as in production
  await setProfile(users.agencyA.id, { organization_id: orgA, role_id: roleId('SUPER_ADMIN') })
  await setProfile(users.agencyB.id, { organization_id: orgB, role_id: roleId('SUPER_ADMIN') })
  await setProfile(users.suspended.id, { organization_id: orgS, role_id: roleId('SUPER_ADMIN') })

  const clientAName = `ZZ E2E Client A ${run}`
  const clientBName = `ZZ E2E Client B ${run}`
  const clients = await must(
    admin
      .from('clients')
      .insert([
        { name: clientAName, organization_id: orgA, segment: 'postpaid' },
        { name: clientBName, organization_id: orgB, segment: 'postpaid' },
      ])
      .select('id, name'),
    'clients',
  )
  const clientA = clients.find((c) => c.name === clientAName)!.id
  const clientB = clients.find((c) => c.name === clientBName)!.id

  await setProfile(users.client.id, { organization_id: orgA })
  await must(
    admin
      .from('client_memberships')
      .insert({ user_id: users.client.id, client_id: clientA, organization_id: orgA })
      .select('id'),
    'membership',
  )

  const accountAName = `ZZ E2E Account A ${run}`
  const accountBName = `ZZ E2E Account B ${run}`
  await must(
    admin
      .from('ad_accounts')
      .insert([
        { name: accountAName, platform: 'META', is_platform: false, organization_id: orgA, usd_rate: 0 },
        { name: accountBName, platform: 'META', is_platform: false, organization_id: orgB, usd_rate: 0 },
      ])
      .select('id'),
    'ad_accounts',
  )

  return { run, orgA, orgB, orgS, clientA, clientB, clientAName, clientBName, accountAName, accountBName, users }
}

/** Deletes everything seed() created (and the audit/notification rows the app wrote for it). */
export async function teardown(env: E2EEnv, f: Fixtures): Promise<void> {
  const admin = adminClient(env)
  const orgIds = [f.orgA, f.orgB, f.orgS]
  const userIds = Object.values(f.users).map((u) => u.id)
  // Child → parent, mirroring OFFBOARD_ORDER's constraints.
  for (const t of [
    // subscription_payments first: recorded_by names the platform test user,
    // so it must go before that user can be deleted (it would otherwise only
    // cascade away with the agency, after the user delete already failed).
    'subscription_payments',
    'notifications', 'audit_logs', 'adjustments', 'ledger_entries', 'payments', 'payment_requests',
    'limit_requests', 'platform_account_requests', 'ad_account_assignments', 'attachments',
  ]) {
    await admin.from(t).delete().in('organization_id', orgIds)
  }
  await admin.from('audit_logs').delete().in('actor_user_id', userIds)
  await admin.from('ad_accounts').delete().in('organization_id', orgIds)
  await admin.from('client_memberships').delete().in('organization_id', orgIds)
  await admin.from('clients').delete().in('organization_id', orgIds)
  await admin.from('user_profiles').delete().in('user_id', userIds)
  for (const id of userIds) await admin.auth.admin.deleteUser(id)
  await admin.from('organizations').delete().in('id', orgIds)
}

/** Signs a user in with their password and returns the exact cookies the app's own SSR client would set. */
export async function sessionCookies(env: E2EEnv, email: string) {
  const jar = new Map<string, { value: string; options: Record<string, unknown> }>()
  const sb = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, c]) => ({ name, value: c.value })),
      setAll: (list) => list.forEach((c) => jar.set(c.name, { value: c.value, options: c.options as Record<string, unknown> })),
    },
  })
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`sign in ${email}: ${error.message}`)
  return [...jar].map(([name, c]) => ({ name, value: c.value, url: BASE_URL }))
}
