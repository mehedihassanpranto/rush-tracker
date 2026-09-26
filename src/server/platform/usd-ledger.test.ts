import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dec } from '@/lib/money/money'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The platform's USD/BDT stock ledger against the real project (migration
 * 000041). Two claims matter and neither can be mocked:
 *
 *  1. The MATH — generated rates and the summary views. Asserted as DELTAS so a
 *     ledger that already holds real entries does not break the test.
 *  2. The BOUNDARY (spec §6.5) — buying rates and source names are the
 *     platform's margin and an agency must never read them. This is checked
 *     with rows PRESENT, because an empty table looks locked either way, and
 *     for both `anon` and a signed-in `authenticated` user, on the tables AND
 *     the views (a default view runs with its owner's rights and would leak
 *     past RLS — the reason the views are security_invoker and revoked).
 *
 * Every row it writes carries an explicit reference_id so it never consumes a
 * usd_sale_seq number (a real sale's USD-YYYY-NNNNN must not skip because of a
 * test), and everything is deleted afterwards. Skips without credentials, like
 * pool-isolation.test.ts.
 */
function loadEnv(): { url: string; serviceKey: string; anonKey: string } | null {
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
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
    const anonKey = env.VITE_SUPABASE_ANON_KEY
    return url && serviceKey && anonKey ? { url, serviceKey, anonKey } : null
  } catch {
    return null
  }
}

const creds = loadEnv()
const SUFFIX = `usdtest-${Date.now()}`
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

type Summary = {
  total_usd_purchased: number
  total_bdt_invested: number
  total_usd_sold: number
  total_bdt_received: number
  remaining_usd_stock: number
  gross_bdt_difference: number | null
}

describe.skipIf(!creds)('platform USD stock ledger', () => {
  let admin: SupabaseClient
  let anon: SupabaseClient
  let agent: SupabaseClient // a signed-in, non-platform user
  let sourceA = ''
  let sourceB = ''
  let orgId = ''
  let orgName = ''
  let userId = ''
  let before: Summary
  const purchaseIds: Array<string> = []
  const saleIds: Array<string> = []
  const accountIds: Array<string> = []

  async function summary(): Promise<Summary> {
    const { data, error } = await admin.from('usd_stock_summary').select('*').single()
    if (error) throw new Error(error.message)
    return data as Summary
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    anon = createClient(creds!.url, creds!.anonKey, noSession)

    orgName = `ZZ USD Org ${SUFFIX}`
    const { data: org, error: orgErr } = await admin
      .from('organizations')
      .insert({ name: orgName, subscription_status: 'active' })
      .select('id')
      .single()
    if (orgErr) throw new Error(orgErr.message)
    orgId = org.id

    const { data: sources, error: srcErr } = await admin
      .from('usd_sources')
      .insert([{ name: `ZZ-A-${SUFFIX}` }, { name: `ZZ-B-${SUFFIX}` }])
      .select('id, name')
    if (srcErr) throw new Error(srcErr.message)
    sourceA = sources!.find((s) => s.name.startsWith('ZZ-A'))!.id
    sourceB = sources!.find((s) => s.name.startsWith('ZZ-B'))!.id

    // A signed-in agency-side user: authenticated, and nothing more.
    const email = `zz-usd-${Date.now()}@example.invalid`
    const password = `Zz-${Math.random().toString(36).slice(2)}-9aA!`
    const { data: created, error: userErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (userErr) throw new Error(userErr.message)
    userId = created.user.id
    agent = createClient(creds!.url, creds!.anonKey, noSession)
    const { error: signInErr } = await agent.auth.signInWithPassword({ email, password })
    if (signInErr) throw new Error(signInErr.message)

    before = await summary()
  }, 60_000)

  afterAll(async () => {
    if (!admin) return
    if (saleIds.length) await admin.from('usd_sales').delete().in('id', saleIds)
    if (purchaseIds.length) await admin.from('usd_purchases').delete().in('id', purchaseIds)
    // A failed run can leave rows the id lists never captured.
    await admin.from('usd_sales').delete().like('reference_id', `ZZ-${SUFFIX}%`)
    await admin.from('usd_purchases').delete().in('source_id', [sourceA, sourceB].filter(Boolean))
    await admin.from('usd_sources').delete().in('id', [sourceA, sourceB].filter(Boolean))
    if (accountIds.length) await admin.from('ad_accounts').delete().in('id', accountIds)
    if (orgId) await admin.from('organizations').delete().eq('id', orgId)
    if (userId) await admin.auth.admin.deleteUser(userId)
  }, 60_000)

  it('computes rates in the database: bdt_amount / usd_amount, per transaction', async () => {
    const { data: purchases, error } = await admin
      .from('usd_purchases')
      .insert([
        { source_id: sourceA, usd_amount: 1000, bdt_amount: 122000 },
        { source_id: sourceB, usd_amount: 500, bdt_amount: 62500 },
      ])
      .select('id, source_id, buying_rate')
    expect(error).toBeNull()
    for (const p of purchases!) purchaseIds.push(p.id)
    expect(Number(purchases!.find((p) => p.source_id === sourceA)!.buying_rate)).toBe(122)
    expect(Number(purchases!.find((p) => p.source_id === sourceB)!.buying_rate)).toBe(125)

    const { data: sale, error: saleErr } = await admin
      .from('usd_sales')
      .insert({
        organization_id: orgId,
        agency_name: orgName,
        usd_amount: 300,
        bdt_amount: 37500,
        reference_id: `ZZ-${SUFFIX}-1`,
      })
      .select('id, selling_rate')
      .single()
    expect(saleErr).toBeNull()
    saleIds.push(sale!.id)
    expect(Number(sale!.selling_rate)).toBe(125)
  })

  it('moves the stock summary by exactly what was recorded', async () => {
    const after = await summary()
    expect(after.total_usd_purchased - before.total_usd_purchased).toBeCloseTo(1500, 2)
    expect(after.total_bdt_invested - before.total_bdt_invested).toBeCloseTo(184500, 2)
    expect(after.total_usd_sold - before.total_usd_sold).toBeCloseTo(300, 2)
    expect(after.total_bdt_received - before.total_bdt_received).toBeCloseTo(37500, 2)
  })

  it('keeps remaining stock and the gross difference consistent with weighted-average cost', async () => {
    const s = await summary()
    // remaining = purchased - sold
    expect(
      dec(s.total_usd_purchased).minus(dec(s.total_usd_sold)).minus(dec(s.remaining_usd_stock)).abs().toNumber(),
    ).toBeLessThan(0.01)
    // gross = BDT received - USD sold x (BDT invested / USD purchased)
    const avgBuy = dec(s.total_bdt_invested).div(dec(s.total_usd_purchased))
    const expected = dec(s.total_bdt_received).minus(dec(s.total_usd_sold).mul(avgBuy))
    expect(dec(s.gross_bdt_difference as number).minus(expected).abs().toNumber()).toBeLessThan(0.01)
  })

  it('totals what one agency has bought', async () => {
    const { data, error } = await admin
      .from('agency_usd_summary')
      .select('*')
      .eq('organization_id', orgId)
      .single()
    expect(error).toBeNull()
    expect(Number(data!.total_usd_allocated)).toBe(300)
    expect(Number(data!.total_bdt_paid)).toBe(37500)
    expect(Number(data!.transaction_count)).toBe(1)
    expect(Number(data!.avg_selling_rate)).toBe(125)
  })

  it("stores a source's USD payment method, defaults it to none, and lets it change", async () => {
    // Sources made before migration 000042 (and any insert that omits it) have
    // no method — the column must be nullable, not silently defaulted.
    const { data: bare } = await admin.from('usd_sources').select('payment_method').eq('id', sourceA).single()
    expect(bare!.payment_method).toBeNull()

    const { data: withMethod, error } = await admin
      .from('usd_sources')
      .insert({ name: `ZZ-M-${SUFFIX}`, payment_method: 'Payoneer' })
      .select('id, payment_method')
      .single()
    expect(error).toBeNull()
    expect(withMethod!.payment_method).toBe('Payoneer')

    // Editing it (or setting one on a source that had none) leaves purchases
    // pointing at the same source id.
    const { data: purchase } = await admin
      .from('usd_purchases')
      .insert({ source_id: withMethod!.id, usd_amount: 10, bdt_amount: 1220 })
      .select('id')
      .single()
    purchaseIds.push(purchase!.id)
    const { error: updErr } = await admin
      .from('usd_sources')
      .update({ payment_method: 'Wise' })
      .eq('id', withMethod!.id)
    expect(updErr).toBeNull()
    const { data: joined } = await admin
      .from('usd_purchases')
      .select('source:usd_sources(payment_method)')
      .eq('id', purchase!.id)
      .single()
    expect((joined as unknown as { source: { payment_method: string } }).source.payment_method).toBe('Wise')

    // The boundary covers the new column too: a signed-in agency user cannot
    // read it, or set it.
    expect((await agent.from('usd_sources').select('payment_method')).error).not.toBeNull()
    expect((await agent.from('usd_sources').update({ payment_method: 'PayPal' }).eq('id', withMethod!.id)).error).not.toBeNull()

    await admin.from('usd_purchases').delete().eq('id', purchase!.id)
    purchaseIds.pop()
    await admin.from('usd_sources').delete().eq('id', withMethod!.id)
  })

  it('rejects zero amounts, and a duplicate source name in any capitalisation', async () => {
    // A zero USD amount is refused, but as 22012 (division by zero), not the
    // CHECK's 23514: Postgres computes the generated rate column BEFORE it
    // evaluates CHECK constraints. Either way nothing is stored, and the app
    // never gets this far — the server schema rejects a non-positive amount
    // first ("Must be greater than zero").
    const zeroUsd = await admin
      .from('usd_purchases')
      .insert({ source_id: sourceA, usd_amount: 0, bdt_amount: 100 })
    expect(['22012', '23514']).toContain(zeroUsd.error?.code)
    const zeroBdt = await admin
      .from('usd_sales')
      .insert({ organization_id: orgId, agency_name: orgName, usd_amount: 10, bdt_amount: 0, reference_id: `ZZ-${SUFFIX}-z` })
    expect(zeroBdt.error?.code).toBe('23514')

    const dup = await admin.from('usd_sources').insert({ name: `zz-a-${SUFFIX}`.toLowerCase() })
    expect(dup.error?.code).toBe('23505')
  })

  it('totals approved limit requests per agency exactly as a from-scratch recount does', async () => {
    // Read-only, against the real data: the view must equal a straight
    // recomputation from limit_requests — approved, on platform-owned accounts
    // only. Paged, because a plain select truncates silently at 1,000 rows.
    const rows: Array<{ organization_id: string; approved_amount_usd: number; approved_at: string; ad_account: { is_platform: boolean } }> = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin
        .from('limit_requests')
        .select('organization_id, approved_amount_usd, approved_at, ad_account:ad_accounts(is_platform)')
        .eq('status', 'APPROVED')
        .order('id')
        .range(from, from + 999)
      expect(error).toBeNull()
      rows.push(...(data as unknown as typeof rows))
      if ((data ?? []).length < 1000) break
    }
    const expected = new Map<string, { usd: ReturnType<typeof dec>; n: number }>()
    for (const r of rows) {
      if (!r.ad_account?.is_platform) continue // an agency's own account is not a platform allocation
      const cur = expected.get(r.organization_id) ?? { usd: dec(0), n: 0 }
      expected.set(r.organization_id, { usd: cur.usd.plus(dec(r.approved_amount_usd)), n: cur.n + 1 })
    }

    const { data: view, error } = await admin.from('agency_limit_approvals_summary').select('*')
    expect(error).toBeNull()
    expect(view!.length).toBe(expected.size)
    for (const v of view!) {
      const e = expected.get(v.organization_id)
      expect(e, `unexpected agency ${v.organization_id} in the view`).toBeDefined()
      expect(dec(v.total_usd_approved).minus(e!.usd).abs().toNumber()).toBeLessThan(0.005)
      expect(Number(v.approval_count)).toBe(e!.n)
    }
  })

  it("reports today's approved limit requests on the Asia/Dhaka business day, matching a recount", async () => {
    // "Today" is decided by the database in Asia/Dhaka (not UTC, which would
    // roll over at 6am in Dhaka). Recount independently in JS with the same
    // zone and compare per agency, read-only against the real data.
    const dhakaDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    const today = dhakaDay(new Date().toISOString())

    const rows: Array<{ organization_id: string; approved_amount_usd: number; approved_at: string; ad_account: { is_platform: boolean } }> = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin
        .from('limit_requests')
        .select('organization_id, approved_amount_usd, approved_at, ad_account:ad_accounts(is_platform)')
        .eq('status', 'APPROVED')
        .order('id')
        .range(from, from + 999)
      expect(error).toBeNull()
      rows.push(...(data as unknown as typeof rows))
      if ((data ?? []).length < 1000) break
    }
    const expected = new Map<string, { usd: ReturnType<typeof dec>; n: number }>()
    for (const r of rows) {
      if (!r.ad_account?.is_platform || dhakaDay(r.approved_at) !== today) continue
      const cur = expected.get(r.organization_id) ?? { usd: dec(0), n: 0 }
      expected.set(r.organization_id, { usd: cur.usd.plus(dec(r.approved_amount_usd)), n: cur.n + 1 })
    }

    const { data: view, error } = await admin.from('agency_limit_approvals_summary').select('*')
    expect(error).toBeNull()
    for (const v of view!) {
      const e = expected.get(v.organization_id) ?? { usd: dec(0), n: 0 }
      expect(dec(v.today_usd_approved).minus(e.usd).abs().toNumber(), `today USD for ${v.organization_id}`).toBeLessThan(0.005)
      expect(Number(v.today_approval_count), `today count for ${v.organization_id}`).toBe(e.n)
    }
    // A quiet day reads 0, never NULL.
    for (const v of view!) {
      expect(v.today_usd_approved).not.toBeNull()
      expect(v.today_approval_count).not.toBeNull()
    }
  })

  it('leaves the stock position alone — approvals do not count as USD sold', async () => {
    // total_usd_sold must equal the sum of usd_sales and nothing else.
    const { data: sold } = await admin.from('usd_sales').select('usd_amount')
    const fromSales = (sold ?? []).reduce((sum, r) => sum.plus(dec(r.usd_amount)), dec(0))
    expect(dec((await summary()).total_usd_sold).minus(fromSales).abs().toNumber()).toBeLessThan(0.005)
  })

  // ---------------------------------------------------------------- boundary --

  const PROTECTED = [
    'usd_sources',
    'usd_purchases',
    'usd_sales',
    'usd_stock_summary',
    'agency_usd_summary',
    'agency_limit_approvals_summary',
  ]

  it('gives an anonymous caller nothing — tables or views — with rows present', async () => {
    for (const relation of PROTECTED) {
      const res = await anon.from(relation).select('*')
      expect(res.error, `${relation} should refuse anon`).not.toBeNull()
      expect(res.data ?? [], relation).toHaveLength(0)
    }
  })

  it('gives a signed-in agency user nothing either — the §6.5 boundary', async () => {
    for (const relation of PROTECTED) {
      const res = await agent.from(relation).select('*')
      expect(res.error, `${relation} should refuse authenticated`).not.toBeNull()
      expect(res.data ?? [], relation).toHaveLength(0)
    }
  })

  it('refuses writes from anon and from a signed-in agency user', async () => {
    const row = { source_id: sourceA, usd_amount: 1, bdt_amount: 1 }
    expect((await anon.from('usd_purchases').insert(row)).error).not.toBeNull()
    expect((await agent.from('usd_purchases').insert(row)).error).not.toBeNull()
    expect((await agent.from('usd_sources').insert({ name: `ZZ-x-${SUFFIX}` })).error).not.toBeNull()
    // And it must not have gone through.
    const { count } = await admin
      .from('usd_purchases')
      .select('id', { count: 'exact', head: true })
      .eq('usd_amount', 1)
      .eq('bdt_amount', 1)
      .in('source_id', [sourceA])
    expect(count).toBe(0)
  })

  // -------------------------------------------------------------- survival ---

  it('does not let deleting an ad account block, or erase, a sale earmarked to it', async () => {
    const { data: acct, error: acctErr } = await admin
      .from('ad_accounts')
      .insert({
        name: `ZZ USD Acct ${SUFFIX}`,
        platform: 'META',
        is_platform: true,
        organization_id: null,
        usd_rate: 0,
      })
      .select('id')
      .single()
    expect(acctErr).toBeNull()
    accountIds.push(acct!.id)

    const { data: sale, error } = await admin
      .from('usd_sales')
      .insert({
        organization_id: orgId,
        agency_name: orgName,
        ad_account_id: acct!.id,
        usd_amount: 10,
        bdt_amount: 1250,
        reference_id: `ZZ-${SUFFIX}-2`,
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    saleIds.push(sale!.id)

    const del = await admin.from('ad_accounts').delete().eq('id', acct!.id)
    expect(del.error).toBeNull()
    accountIds.pop()

    const { data: after } = await admin
      .from('usd_sales')
      .select('id, ad_account_id')
      .eq('id', sale!.id)
      .single()
    expect(after).not.toBeNull()
    expect(after!.ad_account_id).toBeNull()
  })

  it('keeps a sale — and its totals — when the buying agency is deleted', async () => {
    const soldBefore = (await summary()).total_usd_sold

    const del = await admin.from('organizations').delete().eq('id', orgId)
    expect(del.error).toBeNull()
    const deletedOrgId = orgId
    orgId = ''

    const { data: sales } = await admin
      .from('usd_sales')
      .select('organization_id, agency_name')
      .in('id', saleIds)
    expect(sales).toHaveLength(2)
    for (const s of sales!) {
      expect(s.organization_id).toBeNull()
      expect(s.agency_name).toBe(orgName)
    }

    // The dollars stay counted as sold — dropping them would put phantom
    // dollars back into stock.
    expect((await summary()).total_usd_sold).toBe(soldBefore)

    // And the surviving rows are grouped under the snapshotted name.
    const { data: removed } = await admin
      .from('agency_usd_summary')
      .select('*')
      .is('organization_id', null)
      .eq('removed_agency_name', orgName)
      .single()
    expect(Number(removed!.total_usd_allocated)).toBe(310)
    expect(Number(removed!.transaction_count)).toBe(2)
    expect(deletedOrgId).not.toBe('')
  })
})
