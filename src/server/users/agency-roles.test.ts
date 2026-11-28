import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLiveTestEnv } from '@/test/live-env'

/**
 * Agency roles (000068) against the real schema: a new agency starts with an
 * "Admin" role holding the system ADMIN defaults, a login can't be given
 * another agency's role, the tables are closed to signed-in clients, and the
 * roles go with their agency.
 */
const creds = loadLiveTestEnv()
const SUFFIX = `roles-${Date.now()}`

describe.skipIf(!creds)('agency roles', () => {
  let admin: SupabaseClient
  const orgs: Array<string> = []
  let userId = ''

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    for (const name of ['A', 'B']) {
      const { data, error } = await admin
        .from('organizations')
        .insert({ name: `ZZ Roles ${name} ${SUFFIX}`, subscription_status: 'active' })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      orgs.push(data.id as string)
    }
    const { data: created, error } = await admin.auth.admin.createUser({
      email: `zz-${SUFFIX}@example.test`,
      password: 'Roles-Pass-123!',
      email_confirm: true,
    })
    if (error) throw new Error(error.message)
    userId = created.user.id
    const { data: adminRole } = await admin.from('roles').select('id').eq('key', 'ADMIN').single()
    const { error: profileErr } = await admin
      .from('user_profiles')
      .update({ organization_id: orgs[0], role_id: adminRole!.id })
      .eq('user_id', userId)
    if (profileErr) throw new Error(profileErr.message)
  }, 30_000)

  afterAll(async () => {
    if (!admin) return
    if (userId) {
      await admin.from('user_profiles').delete().eq('user_id', userId)
      await admin.auth.admin.deleteUser(userId)
    }
    await admin.from('organizations').delete().in('id', orgs)
  }, 30_000)

  async function rolesOf(org: string) {
    const { data, error } = await admin
      .from('agency_roles')
      .select('id, name, grants:agency_role_permissions(permission:permissions(key))')
      .eq('organization_id', org)
    if (error) throw new Error(error.message)
    return (data ?? []) as unknown as Array<{
      id: string
      name: string
      grants: Array<{ permission: { key: string } }>
    }>
  }

  it('a new agency starts with an Admin role holding the old ADMIN defaults', async () => {
    const roles = await rolesOf(orgs[0])
    expect(roles.map((r) => r.name)).toEqual(['Admin'])

    const { data: defaults } = await admin
      .from('role_permissions')
      .select('permission:permissions(key), role:roles!inner(key)')
      .eq('role.key', 'ADMIN')
    const expected = ((defaults ?? []) as unknown as Array<{ permission: { key: string } }>)
      .map((d) => d.permission.key)
      .filter((k) => !k.startsWith('employees.'))
      .sort()
    const keys = roles[0].grants.map((g) => g.permission.key).sort()
    expect(keys).toEqual(expected)
    expect(keys).not.toContain('users.manage')
    expect(keys).not.toContain('adjustments.create')
  })

  it('names are unique per agency, ignoring case and spaces', async () => {
    const { error } = await admin
      .from('agency_roles')
      .insert({ organization_id: orgs[0], name: '  admin ' })
    expect(error?.code).toBe('23505')
    // Another agency may use the same name.
    const { error: other } = await admin
      .from('agency_roles')
      .insert({ organization_id: orgs[1], name: 'Support' })
    expect(other).toBeNull()
  })

  it('a login can hold its own agency’s role but never another agency’s', async () => {
    const [own] = await rolesOf(orgs[0])
    const [foreign] = await rolesOf(orgs[1])
    const { error: ok } = await admin
      .from('user_profiles')
      .update({ agency_role_id: own.id })
      .eq('user_id', userId)
    expect(ok).toBeNull()
    const { error: bad } = await admin
      .from('user_profiles')
      .update({ agency_role_id: foreign.id })
      .eq('user_id', userId)
    expect(bad?.code).toBe('23503')
  })

  it('a role’s permission rows can’t be tagged with another agency', async () => {
    const [role] = await rolesOf(orgs[0])
    const { data: perm } = await admin.from('permissions').select('id').eq('key', 'users.manage').single()
    const { error } = await admin
      .from('agency_role_permissions')
      .insert({ role_id: role.id, permission_id: perm!.id, organization_id: orgs[1] })
    expect(error?.code).toBe('23503')
  })

  it('is closed to signed-in browsers', async () => {
    const anon = createClient(creds!.url, creds!.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data } = await anon.from('agency_roles').select('id').limit(1)
    expect(data ?? []).toEqual([])
  })

  it('goes with its agency', async () => {
    await admin.from('user_profiles').delete().eq('user_id', userId)
    await admin.auth.admin.deleteUser(userId)
    userId = ''
    const { error } = await admin.from('organizations').delete().in('id', orgs)
    expect(error).toBeNull()
    const { count } = await admin
      .from('agency_roles')
      .select('id', { count: 'exact', head: true })
      .in('organization_id', orgs)
    expect(count).toBe(0)
  })
})
