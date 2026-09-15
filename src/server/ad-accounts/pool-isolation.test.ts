import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adAccountScope,
  applyAdAccountScope,
  grantedAccountIds,
  loadAccessibleAdAccount,
  operatingOrganizationId,
} from './scope.server'
import { DEPLOYMENT_ORGANIZATION_ID } from '@/lib/organizations/deployment-org'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Cross-tenant isolation for the platform-owned ad account pool — the core
 * correctness claim of the feature: a pool account granted to one agency must
 * be invisible to every other agency, through every read path.
 *
 * This is a real integration test against the configured Supabase project,
 * not a mock: the union it asserts is expressed in SQL (a PostgREST `or`
 * filter plus a grants lookup), so mocking the database would only re-assert
 * the test's own assumptions. It seeds its own throwaway organizations and
 * deletes them afterwards, and never touches existing rows.
 *
 * It skips cleanly when no credentials are present, keeping `npm test` green
 * in an environment without database access — consistent with this repo's
 * split between DB-independent unit tests and live-project procedures
 * (docs/TESTING.md).
 */
function loadEnv(): { url: string; key: string } | null {
  try {
    const raw = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    const env: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      env[t.slice(0, i).trim()] = t
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
    }
    const url = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL
    const key = env.SUPABASE_SERVICE_ROLE_KEY
    return url && key ? { url, key } : null
  } catch {
    return null
  }
}

const creds = loadEnv()
const SUFFIX = `pooltest-${Date.now()}`

describe.skipIf(!creds)('platform account pool — cross-tenant isolation', () => {
  let admin: SupabaseClient
  let orgA = ''
  let orgB = ''
  let poolAccountId = ''
  let ownedByBId = ''

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: orgs, error: orgErr } = await admin
      .from('organizations')
      .insert([
        { name: `ZZ Pool A ${SUFFIX}`, subscription_status: 'active' },
        { name: `ZZ Pool B ${SUFFIX}`, subscription_status: 'active' },
      ])
      .select('id, name')
    if (orgErr) throw new Error(orgErr.message)
    orgA = orgs!.find((o) => o.name.includes('Pool A'))!.id
    orgB = orgs!.find((o) => o.name.includes('Pool B'))!.id

    // One platform-owned pool account, and one account owned outright by B —
    // so the test proves the union includes B's own while excluding A's grant.
    const { data: accounts, error: accErr } = await admin
      .from('ad_accounts')
      .insert([
        {
          name: `ZZ Pool Account ${SUFFIX}`,
          platform: 'META',
          is_platform: true,
          organization_id: null,
          usd_rate: 0,
        },
        {
          name: `ZZ B Owned ${SUFFIX}`,
          platform: 'META',
          is_platform: false,
          organization_id: orgB,
          usd_rate: 0,
        },
      ])
      .select('id, name')
    if (accErr) throw new Error(accErr.message)
    poolAccountId = accounts!.find((a) => a.name.includes('Pool Account'))!.id
    ownedByBId = accounts!.find((a) => a.name.includes('B Owned'))!.id

    const { error: grantErr } = await admin
      .from('platform_account_grants')
      .insert({ ad_account_id: poolAccountId, organization_id: orgA })
    if (grantErr) throw new Error(grantErr.message)
  }, 30_000)

  afterAll(async () => {
    if (!admin) return
    await admin.from('ad_account_assignments').delete().eq('ad_account_id', poolAccountId)
    await admin.from('platform_account_grants').delete().eq('ad_account_id', poolAccountId)
    await admin.from('clients').delete().in('organization_id', [orgA, orgB])
    await admin.from('audit_logs').delete().in('organization_id', [orgA, orgB])
    await admin.from('ad_accounts').delete().in('id', [poolAccountId, ownedByBId])
    await admin.from('organizations').delete().in('id', [orgA, orgB])
  }, 30_000)

  it('grants the pool account to A and only A', async () => {
    expect(await grantedAccountIds(admin, orgA)).toContain(poolAccountId)
    expect(await grantedAccountIds(admin, orgB)).not.toContain(poolAccountId)
  })

  it("A's scoped account list includes the granted pool account", async () => {
    const scope = await adAccountScope(admin, orgA)
    const { data } = await applyAdAccountScope(
      admin.from('ad_accounts').select('id'),
      scope,
    )
    expect((data ?? []).map((r) => r.id)).toContain(poolAccountId)
  })

  it("B's scoped account list NEVER returns A's granted pool account", async () => {
    const scope = await adAccountScope(admin, orgB)
    const { data } = await applyAdAccountScope(
      admin.from('ad_accounts').select('id'),
      scope,
    )
    const ids = (data ?? []).map((r) => r.id)
    expect(ids).not.toContain(poolAccountId)
    // …while still returning the account B owns outright, proving the filter
    // excludes the grant specifically rather than returning nothing at all.
    expect(ids).toContain(ownedByBId)
  })

  it('refuses B a by-id read of the granted account, indistinguishably from missing', async () => {
    await expect(
      loadAccessibleAdAccount(admin, poolAccountId, orgB),
    ).rejects.toThrow('Ad account not found')
    await expect(
      loadAccessibleAdAccount(admin, poolAccountId, orgA),
    ).resolves.toMatchObject({ id: poolAccountId, is_platform: true })
  })

  it('attributes the pool account to A for audit and notifications', async () => {
    const account = { id: poolAccountId, is_platform: true, organization_id: null }
    expect(await operatingOrganizationId(admin, account)).toBe(orgA)
  })

  it('REFUSES agency B assigning a pool account granted to A (IDOR guard)', async () => {
    // Regression for a real hole: the assignment RPCs validated ownership with
    // `v_account.organization_id <> p_organization_id`, and a pool account's
    // organization_id is NULL — `NULL <> x` is NULL, which PL/pgSQL's IF treats
    // as false, so the guard never fired and ANY agency could take ANY pool
    // account. Fixed in migration 20260723000036 via org_can_use_ad_account().
    const { data: clientB } = await admin
      .from('clients')
      .insert({
        name: `ZZ Pool IDOR client ${SUFFIX}`,
        organization_id: orgB,
        usd_rate: 130,
        segment: 'postpaid',
      })
      .select('id')
      .single()

    const { error } = await admin.rpc('assign_ad_account', {
      p_account_id: poolAccountId,
      p_client_id: clientB!.id,
      p_actor: null,
      p_organization_id: orgB,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('not found')

    const { data: assignments } = await admin
      .from('ad_account_assignments')
      .select('id')
      .eq('ad_account_id', poolAccountId)
    expect(assignments ?? []).toHaveLength(0)

    await admin.from('clients').delete().eq('id', clientB!.id)
  })

  it('ALLOWS the agency actually holding the grant to assign it', async () => {
    // The other half: the fix must not lock out the legitimate holder.
    const { data: clientA } = await admin
      .from('clients')
      .insert({
        name: `ZZ Pool holder client ${SUFFIX}`,
        organization_id: orgA,
        usd_rate: 130,
        segment: 'postpaid',
      })
      .select('id')
      .single()

    const { error } = await admin.rpc('assign_ad_account', {
      p_account_id: poolAccountId,
      p_client_id: clientA!.id,
      p_actor: null,
      p_organization_id: orgA,
    })
    expect(error).toBeNull()

    await admin.rpc('release_ad_account', {
      p_account_id: poolAccountId,
      p_actor: null,
      p_organization_id: orgA,
      p_notes: null,
    })
    await admin.from('ad_account_assignments').delete().eq('ad_account_id', poolAccountId)
    await admin.from('audit_logs').delete().eq('organization_id', orgA)
    await admin.from('clients').delete().eq('id', clientA!.id)
  })

  it('moves the account to B when the grant is revoked and re-granted', async () => {
    await admin.from('platform_account_grants').delete().eq('ad_account_id', poolAccountId)
    await admin
      .from('platform_account_grants')
      .insert({ ad_account_id: poolAccountId, organization_id: orgB })

    expect(await grantedAccountIds(admin, orgA)).not.toContain(poolAccountId)
    expect(await grantedAccountIds(admin, orgB)).toContain(poolAccountId)
  })

  it('refuses to grant the same account to two agencies at once', async () => {
    const { error } = await admin
      .from('platform_account_grants')
      .insert({ ad_account_id: poolAccountId, organization_id: orgA })
    expect(error).not.toBeNull()
  })

  it("regression: xRush's own fleet is unchanged and still fully reachable", async () => {
    // Every account xRush could see before the pool migration it must still
    // see afterwards — they moved into the pool and were granted straight back.
    const scope = await adAccountScope(admin, DEPLOYMENT_ORGANIZATION_ID)
    const { data } = await applyAdAccountScope(
      admin.from('ad_accounts').select('id, is_platform'),
      scope,
    )
    const visible = data ?? []
    const granted = await grantedAccountIds(admin, DEPLOYMENT_ORGANIZATION_ID)
    expect(visible.length).toBe(granted.length)
    expect(visible.length).toBeGreaterThan(0)
    // …and none of the throwaway org's accounts leaked in.
    expect(visible.map((r) => r.id)).not.toContain(ownedByBId)
  })
})
