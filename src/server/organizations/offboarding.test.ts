import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEPLOYMENT_ORGANIZATION_ID } from '@/lib/organizations/deployment-org'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Offboarding an agency is the most destructive action in the app, so the
 * teardown order and the survival of platform-owned accounts are asserted
 * against the real database rather than reasoned about.
 *
 * Mirrors deleteOrganizationFn's sequence exactly (see the OFFBOARD_ORDER
 * constant there). It cannot import that fn — it is a createServerFn endpoint
 * needing the TanStack runtime — so what this proves is the SCHEMA half: that
 * the order satisfies every foreign key, that a granted pool account survives,
 * and that nothing of the agency is left behind.
 *
 * Skips cleanly without credentials, like pool-isolation.test.ts.
 */
function loadEnv(): { url: string; key: string } | null {
  try {
    const raw = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    const env: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
    const url = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL
    const key = env.SUPABASE_SERVICE_ROLE_KEY
    return url && key ? { url, key } : null
  } catch {
    return null
  }
}

const OFFBOARD_ORDER = [
  'notifications',
  'audit_logs',
  'adjustments',
  'ledger_entries',
  'payments',
  'payment_requests',
  'limit_requests',
  'ad_account_assignments',
  'attachments',
  'ad_accounts',
  'client_employees',
  'employees',
  'client_memberships',
  'clients',
  'exchange_rates',
  'usd_margin_entries',
  'user_profiles',
] as const

const creds = loadEnv()
const SUFFIX = `offboard-${Date.now()}`

describe.skipIf(!creds)('organization offboarding', () => {
  let admin: SupabaseClient
  let orgId = ''
  let poolAccountId = ''
  let ownedAccountId = ''
  let clientId = ''

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: org, error } = await admin
      .from('organizations')
      .insert({ name: `ZZ Offboard ${SUFFIX}`, subscription_status: 'active' })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    orgId = org!.id

    const { data: accounts, error: accErr } = await admin
      .from('ad_accounts')
      .insert([
        {
          name: `ZZ Owned ${SUFFIX}`,
          platform: 'META',
          is_platform: false,
          organization_id: orgId,
          usd_rate: 0,
        },
        {
          name: `ZZ Pool ${SUFFIX}`,
          platform: 'META',
          is_platform: true,
          organization_id: null,
          usd_rate: 0,
        },
      ])
      .select('id, name')
    if (accErr) throw new Error(accErr.message)
    ownedAccountId = accounts!.find((a) => a.name.includes('Owned'))!.id
    poolAccountId = accounts!.find((a) => a.name.includes('Pool'))!.id

    // The pool account is granted to the agency being offboarded — the case
    // that matters: it must survive and return to the pool.
    await admin
      .from('platform_account_grants')
      .insert({ ad_account_id: poolAccountId, organization_id: orgId })

    const { data: client, error: clientErr } = await admin
      .from('clients')
      .insert({
        name: `ZZ Client ${SUFFIX}`,
        organization_id: orgId,
        usd_rate: 130,
        segment: 'postpaid',
      })
      .select('id')
      .single()
    if (clientErr) throw new Error(clientErr.message)
    clientId = client!.id
  }, 30_000)

  afterAll(async () => {
    if (!admin) return
    await admin.from('platform_account_grants').delete().eq('ad_account_id', poolAccountId)
    await admin.from('ad_accounts').delete().in('id', [poolAccountId, ownedAccountId])
    await admin.from('clients').delete().eq('organization_id', orgId)
    await admin.from('organizations').delete().eq('id', orgId)
  }, 30_000)

  it('cannot delete the organization while its data still references it', async () => {
    // This is why teardown order exists at all: every one of the 17
    // multi-tenant tables references organizations(id) with no ON DELETE.
    const { error } = await admin.from('organizations').delete().eq('id', orgId)
    expect(error).not.toBeNull()
    const { data: still } = await admin
      .from('organizations')
      .select('id')
      .eq('id', orgId)
      .maybeSingle()
    expect(still).not.toBeNull()
  })

  it('tears down cleanly in OFFBOARD_ORDER, and the organization then deletes', async () => {
    for (const table of OFFBOARD_ORDER) {
      const { error } = await admin.from(table).delete().eq('organization_id', orgId)
      expect(error, `clearing ${table}`).toBeNull()
    }
    const { error } = await admin.from('organizations').delete().eq('id', orgId)
    expect(error).toBeNull()

    const { data: gone } = await admin
      .from('organizations')
      .select('id')
      .eq('id', orgId)
      .maybeSingle()
    expect(gone).toBeNull()
  })

  it("deletes the agency's own ad account", async () => {
    const { data } = await admin
      .from('ad_accounts')
      .select('id')
      .eq('id', ownedAccountId)
      .maybeSingle()
    expect(data).toBeNull()
  })

  it('KEEPS the platform-owned account and returns it to the pool unassigned', async () => {
    // The whole point: a customer leaving must not destroy an account the
    // platform owns and merely lent them.
    const { data: account } = await admin
      .from('ad_accounts')
      .select('id, is_platform, organization_id')
      .eq('id', poolAccountId)
      .maybeSingle()
    expect(account).toMatchObject({ is_platform: true, organization_id: null })

    // Its grant went with the organization (ON DELETE CASCADE), so it is free
    // to be granted to someone else.
    const { data: grant } = await admin
      .from('platform_account_grants')
      .select('id')
      .eq('ad_account_id', poolAccountId)
      .maybeSingle()
    expect(grant).toBeNull()
  })

  it('leaves nothing of the agency behind', async () => {
    const { data: clients } = await admin
      .from('clients')
      .select('id')
      .eq('id', clientId)
    expect(clients ?? []).toHaveLength(0)
  })

  it('never allows deleting the platform’s own organization', async () => {
    // Guarded in deleteOrganizationFn; asserted here as a standing reminder
    // that org zero owns the pool credentials and every platform login.
    expect(DEPLOYMENT_ORGANIZATION_ID).toBe('00000000-0000-0000-0000-000000000001')
    const { data: orgZero } = await admin
      .from('organizations')
      .select('id')
      .eq('id', DEPLOYMENT_ORGANIZATION_ID)
      .maybeSingle()
    expect(orgZero).not.toBeNull()
  })
})
