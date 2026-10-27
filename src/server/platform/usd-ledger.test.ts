import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dec } from '@/lib/money/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLiveTestEnv } from '@/test/live-env'
import { GOLDEN } from '@/lib/finance/golden-dataset'
import { defaultFeeRules, manualFee, resolveFeeRule } from '@/lib/finance/fees'
import type { FeeChannel } from '@/lib/finance/fees'

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
const creds = loadLiveTestEnv()
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
    // Purchases and sales can't be deleted (000062: the journal would no
    // longer tie out). Purchases are reversed; sales stay — they have no
    // reversal path until receivables (Milestone 4), and staging is
    // disposable. Sources with purchases are deactivated, not deleted.
    const { data: mine } = await admin
      .from('usd_purchases')
      .select('id')
      .eq('status', 'POSTED')
      .in('source_id', [sourceA, sourceB].filter(Boolean))
    for (const p of mine ?? []) {
      await admin.rpc('reverse_usd_purchase', { p_actor: null, p_purchase_id: p.id, p_reason: 'test cleanup' })
    }
    await admin.from('usd_sources').update({ is_active: false }).in('id', [sourceA, sourceB].filter(Boolean))
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

    await admin.rpc('reverse_usd_purchase', { p_actor: null, p_purchase_id: purchase!.id, p_reason: 'test cleanup' })
    purchaseIds.pop()
    await admin.from('usd_sources').update({ is_active: false }).eq('id', withMethod!.id)
  })

  it('refuses to delete a purchase or a sale — corrections are reversals (000062)', async () => {
    const del = await admin.from('usd_purchases').delete().eq('id', purchaseIds[0])
    expect(del.error?.message).toMatch(/IMMUTABLE/)
    const delSale = await admin.from('usd_sales').delete().eq('id', saleIds[0])
    expect(delSale.error?.message).toMatch(/IMMUTABLE/)
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

/**
 * Finance v2 FIFO inventory (migration 000059) against the real database, with
 * the hand-computed golden dataset (src/lib/finance/golden-dataset.ts): the
 * RPCs must land on the same paisa as the engine.
 *
 * In THIS file on purpose: Vitest runs files in parallel but describe blocks
 * of one file in order, hooks scoped. The block above inserts and deletes
 * plain purchases; if this block's FIFO drew from them, their cleanup would
 * fail on the allocation FK.
 *
 * Self-contained against whatever staging already holds: it first drains the
 * inventory with one outflow, so FIFO only sees this test's batches, and at
 * the end reverses everything it posted (newest first) and then the drain.
 * The rows stay — the ledger is insert-only, which is the point — reversed.
 */
describe.skipIf(!creds)('Finance v2 FIFO inventory (000059)', () => {
  let admin: SupabaseClient
  let anon: SupabaseClient
  let sourceId = ''
  let drainId: string | null = null
  const outflowIds: Array<string> = []
  const batchIds: Record<string, string> = {}
  const base = Date.now() + 60_000
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString()

  const rules = () => defaultFeeRules('2020-01-01')
  const ruleFee = (channel: FeeChannel, from: string, to: string, amount: number) =>
    resolveFeeRule(rules(), { channel, from_institution: from, to_institution: to, date: '2026-10-20', transfer_amount: amount })

  async function purchase(gross: number, principal: number, fees: Array<unknown>, minutes: number, ref?: string) {
    return admin.rpc('post_usd_purchase', {
      p_actor: null,
      p_source_id: sourceId,
      p_gross_usd: gross,
      p_bdt_principal: principal,
      p_fees: fees,
      p_purchased_at: at(minutes),
      p_method: null,
      p_external_reference: ref ?? null,
      p_notes: `v2 test ${SUFFIX}`,
    })
  }
  async function outflow(usd: number, key = `${SUFFIX}-${Math.random()}`) {
    return admin.rpc('post_usd_outflow', {
      p_actor: null,
      p_kind: 'OTHER',
      p_usd: usd,
      p_event_at: at(30),
      p_ad_account_id: null,
      p_idempotency_key: key,
      p_notes: `v2 test ${SUFFIX}`,
    })
  }
  async function fifo() {
    const { data, error } = await admin.from('usd_fifo_summary').select('left_usd, left_bdt').single()
    if (error) throw new Error(error.message)
    return { usd: dec(data.left_usd).toFixed(2), bdt: dec(data.left_bdt).toFixed(2) }
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    anon = createClient(creds!.url, creds!.anonKey, noSession)
    const { data: src, error } = await admin
      .from('usd_sources')
      .insert({ name: `ZZ-V2-${SUFFIX}`, payment_method: 'Binance', receiving_institution: 'DBBL' })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    sourceId = src.id

    const left = await fifo()
    if (dec(left.usd).gt(0)) {
      const { data, error: dErr } = await outflow(dec(left.usd).toNumber(), `drain-${SUFFIX}`)
      if (dErr) throw new Error(dErr.message)
      drainId = (data as { id: string }).id
    }
  }, 60_000)

  afterAll(async () => {
    if (!admin) return
    for (const id of [...outflowIds].reverse()) {
      await admin.rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: id, p_reason: 'test cleanup' })
    }
    for (const id of Object.values(batchIds)) {
      await admin.rpc('reverse_usd_purchase', { p_actor: null, p_purchase_id: id, p_reason: 'test cleanup' })
    }
    if (drainId) {
      await admin.rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: drainId, p_reason: 'test cleanup' })
    }
    if (sourceId) await admin.from('usd_sources').update({ is_active: false }).eq('id', sourceId)
  }, 60_000)

  it('posts the golden batches: cost is the taka that left, at the deal rate', async () => {
    expect(await fifo()).toEqual({ usd: '0.00', bdt: '0.00' })
    const g = GOLDEN.batches
    const b1 = await purchase(1000, Number(g.B1.principal), [ruleFee('BINANCE', 'Binance', 'Binance', 1000), ruleFee('BANK_INTERNAL', 'DBBL', 'DBBL', 1)], 1, `ref-${SUFFIX}`)
    const b2 = await purchase(500, Number(g.B2.principal), [
      manualFee({ currency: 'USD', total: 10, your_share: 4, reason: 'Payoneer statement', gross: 500 }),
      ruleFee('NPSB', 'DBBL', 'BRAC', 1),
    ], 2)
    const b3 = await purchase(300, Number(g.B3.principal), [ruleFee('BINANCE', 'Binance', 'Binance', 300), ruleFee('BANK_INTERNAL', 'DBBL', 'DBBL', 1)], 3)
    for (const [name, res, want] of [['B1', b1, g.B1], ['B2', b2, g.B2], ['B3', b3, g.B3]] as const) {
      expect(res.error).toBeNull()
      const row = res.data as Record<string, unknown>
      batchIds[name] = row.id as string
      expect(dec(row.net_usd as number).toFixed(6)).toBe(want.net_usd)
      expect(dec(row.capitalized_fees_bdt as number).toFixed(2)).toBe(want.fees_bdt)
      expect(dec(row.bdt_amount as number).toFixed(2)).toBe(want.cost)
      expect(dec(row.supplier_rate as number).toFixed(6)).toBe(want.rate)
      expect(row.rate_warning).toBe(false)
    }
    expect(await fifo()).toEqual({ usd: '1789.98', bdt: '228489.00' })
  })

  it('a duplicate transfer reference posts nothing new', async () => {
    const again = await purchase(1000, 126000, [ruleFee('BINANCE', 'Binance', 'Binance', 1000)], 4, ` REF-${SUFFIX} `)
    expect(again.error).toBeNull()
    expect(again.data).toMatchObject({ id: batchIds.B1, duplicate: true })
    expect(await fifo()).toEqual({ usd: '1789.98', bdt: '228489.00' })
  })

  it('draws FIFO oldest first and splits across batches, to the paisa', async () => {
    const one = await outflow(700)
    expect(one.error).toBeNull()
    outflowIds.push((one.data as { id: string }).id)
    expect(dec((one.data as { bdt_cost: number }).bdt_cost).toFixed(2)).toBe(GOLDEN.prepaidFunding.bdt)

    const two = await outflow(450)
    expect(two.error).toBeNull()
    const twoId = (two.data as { id: string }).id
    outflowIds.push(twoId)
    expect(dec((two.data as { bdt_cost: number }).bdt_cost).toFixed(2)).toBe(GOLDEN.postpaidSettlement.bdt)

    const { data: allocs } = await admin
      .from('inventory_allocations')
      .select('batch_id, usd, bdt')
      .eq('outflow_id', twoId)
    const byBatch = Object.fromEntries((allocs ?? []).map((a) => [a.batch_id, [dec(a.usd).toFixed(6), dec(a.bdt).toFixed(2)]]))
    expect(byBatch).toEqual({
      [batchIds.B1]: ['299.990000', '37799.12'],
      [batchIds.B2]: ['150.010000', '19436.70'],
    })
    expect(await fifo()).toEqual({ usd: '639.98', bdt: GOLDEN.closingInventory.bdt })
  })

  async function entryFor(sourceType: string, sourceId: string, reversal = false) {
    const { data, error } = await admin
      .from('journal_entries')
      .select('id, lines:journal_lines(account_code, debit_bdt, credit_bdt, usd_amount)')
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .eq('is_reversal', reversal)
      .single()
    if (error) throw new Error(error.message)
    return (data.lines as Array<{ account_code: string; debit_bdt: number; credit_bdt: number; usd_amount: number | null }>)
      .map((l) => [l.account_code, dec(l.debit_bdt).toFixed(2), dec(l.credit_bdt).toFixed(2)])
      .sort()
  }

  it('posts a balanced journal entry for every purchase and payout (000061)', async () => {
    // B2: inventory at cost; the supplier and the NPSB fee as separate credits.
    expect(await entryFor('USD_PURCHASE', batchIds.B2)).toEqual([
      ['1010', '0.00', '10.00'],
      ['1010', '0.00', '63479.00'],
      ['1200', '63489.00', '0.00'],
    ].sort())
    // B1 went DBBL → DBBL: the free bank fee posts no line at all.
    expect(await entryFor('USD_PURCHASE', batchIds.B1)).toEqual([
      ['1010', '0.00', '126000.00'],
      ['1200', '126000.00', '0.00'],
    ].sort())
    // The split payout: one entry at its FIFO cost.
    expect(await entryFor('USD_OUTFLOW', outflowIds[1])).toEqual([
      ['1200', '0.00', GOLDEN.postpaidSettlement.bdt],
      ['5900', GOLDEN.postpaidSettlement.bdt, '0.00'],
    ].sort())
  })

  it('refuses: more than in stock, a backdated purchase, reversing a used batch, a manual fee without a reason', async () => {
    expect((await outflow(640)).error?.message).toMatch(/^INSUFFICIENT_INVENTORY/)
    expect((await purchase(100, 12700, [], -5)).error?.message).toMatch(/^BACKDATED_PURCHASE/)
    const used = await admin.rpc('reverse_usd_purchase', { p_actor: null, p_purchase_id: batchIds.B1, p_reason: 'x' })
    expect(used.error?.message).toMatch(/^BATCH_CONSUMED/)
    const noReason = { ...manualFee({ currency: 'USD', total: 1, reason: 'x' }), reason: '' }
    expect((await purchase(100, 12700, [noReason], 10)).error?.message).toMatch(/^FEE_INVALID/)
    const bill = await admin.rpc('post_usd_outflow', {
      p_actor: null, p_kind: 'META_BILL_PAYMENT', p_usd: 1, p_event_at: at(30),
      p_ad_account_id: '00000000-0000-0000-0000-0000000000ff', p_idempotency_key: null, p_notes: null,
    })
    expect(bill.error?.message).toMatch(/^NOT_FOUND/)
    expect(await fifo()).toEqual({ usd: '639.98', bdt: GOLDEN.closingInventory.bdt })
  })

  it('a retried outflow with the same key posts once', async () => {
    const key = `retry-${SUFFIX}`
    const first = await outflow(10, key)
    const second = await outflow(10, key)
    expect(first.error).toBeNull()
    outflowIds.push((first.data as { id: string }).id)
    expect(second.data).toMatchObject({ id: (first.data as { id: string }).id, duplicate: true })
    expect((await fifo()).usd).toBe('629.98')
  })

  it('two outflows at once cannot spend the same dollars', async () => {
    const [a, b] = await Promise.all([outflow(400), outflow(400)])
    const ok = [a, b].filter((r) => !r.error)
    expect(ok).toHaveLength(1)
    outflowIds.push((ok[0].data as { id: string }).id)
    expect([a, b].find((r) => r.error)?.error?.message).toMatch(/^INSUFFICIENT_INVENTORY/)
    expect((await fifo()).usd).toBe('229.98')
  })

  it('reversing an outflow puts back exactly what it took; allocation rows cannot be edited', async () => {
    const last = outflowIds.pop()!
    const rev = await admin.rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: last, p_reason: 'test' })
    expect(rev.error).toBeNull()
    expect((await fifo()).usd).toBe('629.98')
    const again = await admin.rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: last, p_reason: 'test' })
    expect(again.error?.message).toMatch(/^ALREADY_REVERSED/)

    const del = await admin.from('inventory_allocations').delete().eq('outflow_id', last)
    expect(del.error?.message).toMatch(/IMMUTABLE/)
    const upd = await admin.from('inventory_allocations').update({ bdt: 0 }).eq('outflow_id', last)
    expect(upd.error?.message).toMatch(/IMMUTABLE/)
    const audit = await admin.from('platform_finance_audit').delete().eq('entity_id', last)
    expect(audit.error?.message).toMatch(/IMMUTABLE/)
  })

  it('journal: reversals mirror, unbalanced entries are refused, rows are immutable, the books tie to FIFO', async () => {
    // The outflow reversed in the previous test has a mirror entry.
    const { data: rev } = await admin
      .from('usd_outflows')
      .select('id')
      .eq('status', 'REVERSED')
      .like('notes', `v2 test ${SUFFIX}`)
      .limit(1)
      .single()
    const original = await entryFor('USD_OUTFLOW', rev!.id)
    const mirror = await entryFor('USD_OUTFLOW', rev!.id, true)
    expect(mirror).toEqual(original.map(([a, d, c]) => [a, c, d]).sort())

    // A one-sided entry cannot commit: the deferred check rolls it back.
    const { data: lonely } = await admin
      .from('journal_entries')
      .insert({ event_at: at(40), source_type: 'MANUAL', description: `unbalanced ${SUFFIX}` })
      .select('id')
    expect(lonely ?? []).toEqual([])
    const { count } = await admin
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('description', `unbalanced ${SUFFIX}`)
    expect(count).toBe(0)

    const { data: anyEntry } = await admin.from('journal_entries').select('id').limit(1).single()
    expect((await admin.from('journal_entries').delete().eq('id', anyEntry!.id)).error?.message).toMatch(/IMMUTABLE/)
    expect((await admin.from('journal_lines').update({ memo: 'x' }).eq('entry_id', anyEntry!.id)).error?.message).toMatch(/IMMUTABLE/)

    // Everything ever posted: inventory in the books = the FIFO stock.
    const { data: tb, error } = await admin.rpc('gl_trial_balance', { p_as_of: 'infinity' })
    expect(error).toBeNull()
    const rows = tb as Array<{ code: string; debit_bdt: number; credit_bdt: number; balance_bdt: number; usd: number | null }>
    const sum = (k: 'debit_bdt' | 'credit_bdt') => rows.reduce((a, r) => a.plus(r[k]), dec(0)).toFixed(2)
    expect(sum('debit_bdt')).toBe(sum('credit_bdt'))
    const inv = rows.find((r) => r.code === '1200')!
    const left = await fifo()
    expect(dec(inv.balance_bdt).toFixed(2)).toBe(left.bdt)
    expect(dec(inv.usd ?? 0).toFixed(2)).toBe(left.usd)
  })

  it('anon and signed-in users reach none of it', async () => {
    for (const t of ['fee_rules', 'usd_outflows', 'inventory_allocations', 'platform_finance_audit', 'usd_batch_balances', 'usd_fifo_summary', 'gl_accounts', 'journal_entries', 'journal_lines']) {
      const { data } = await anon.from(t).select('*').limit(1)
      expect(data ?? [], t).toEqual([])
    }
    const rpc = await anon.rpc('post_usd_outflow', {
      p_actor: null, p_kind: 'OTHER', p_usd: 1, p_event_at: at(30),
      p_ad_account_id: null, p_idempotency_key: null, p_notes: 'x',
    })
    expect(rpc.error).not.toBeNull()
    expect((await anon.rpc('gl_trial_balance', { p_as_of: 'infinity' })).error).not.toBeNull()
  })
})

/**
 * Finance v2 Meta accounts (migration 000063): the golden dataset's Meta half
 * through the real RPCs — prepaid account P funded and spent from its own
 * lot, postpaid account Q read from Meta's amount_spent and settled by a bill
 * payment at FIFO cost — plus a drop in Meta's figure, prepaid overspend and
 * the mode-change guard. Same isolation as the block above: drain, post the
 * golden batches, reverse everything after.
 */
describe.skipIf(!creds)('Finance v2 Meta accounts (000063)', () => {
  let admin: SupabaseClient
  let sourceId = ''
  let drainId: string | null = null
  let P = ''
  let Q = ''
  const outflows: Array<string> = []
  const batches: Array<string> = []
  const base = Date.now() + 2 * 60 * 60_000 // after the block above's future dates
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString()
  const tag = `meta-${SUFFIX}`

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data as Record<string, unknown>
  }
  const outflow = (kind: string, usd: number, account: string | null, minutes: number) =>
    rpc('post_usd_outflow', {
      p_actor: null, p_kind: kind, p_usd: usd, p_event_at: at(minutes),
      p_ad_account_id: account, p_idempotency_key: null, p_notes: tag,
    })
  // Simulate the daily refresh writing Meta's figure, then the reading job.
  async function reading(spent: Record<string, number>, minutes: number) {
    for (const [id, amount] of Object.entries(spent)) {
      const { error } = await admin
        .from('ad_accounts')
        .update({ meta_amount_spent: amount, meta_currency: 'USD', meta_refreshed_at: at(minutes) })
        .eq('id', id)
      if (error) throw new Error(error.message)
    }
    return rpc('record_meta_spend_readings', { p_actor: null })
  }
  async function position(id: string) {
    const { data, error } = await admin.from('meta_account_positions').select('*').eq('ad_account_id', id).single()
    if (error) throw new Error(error.message)
    const f = (k: string) => dec(data[k] as number).toFixed(2)
    return { spent: f('spent_usd'), funded: f('funded_usd'), left: f('prepaid_left_usd'), leftBdt: f('prepaid_left_bdt'), paid: f('paid_usd'), owed: f('owed_usd') }
  }
  async function lastSpend(id: string) {
    const { data, error } = await admin
      .from('meta_spend_events')
      .select('*')
      .eq('ad_account_id', id)
      .eq('status', 'POSTED')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (error) throw new Error(error.message)
    return data as Record<string, unknown>
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    const { data: src, error } = await admin
      .from('usd_sources')
      .insert({ name: `ZZ-META-${SUFFIX}`, payment_method: 'Binance', receiving_institution: 'DBBL' })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    sourceId = src.id

    const { data: left } = await admin.from('usd_fifo_summary').select('left_usd').single()
    if (dec(left!.left_usd).gt(0)) {
      const d = await rpc('post_usd_outflow', {
        p_actor: null, p_kind: 'OTHER', p_usd: dec(left!.left_usd).toNumber(), p_event_at: at(0),
        p_ad_account_id: null, p_idempotency_key: `meta-drain-${SUFFIX}`, p_notes: tag,
      })
      drainId = d.id as string
    }

    const g = GOLDEN.batches
    const binance = (amount: number) =>
      resolveFeeRule(defaultFeeRules('2020-01-01'), { channel: 'BINANCE', from_institution: 'Binance', to_institution: 'Binance', date: '2026-10-20', transfer_amount: amount })
    const npsb = resolveFeeRule(defaultFeeRules('2020-01-01'), { channel: 'NPSB', from_institution: 'DBBL', to_institution: 'BRAC', date: '2026-10-20', transfer_amount: 1 })
    for (const [i, [gross, principal, fees]] of ([
      [1000, g.B1.principal, [binance(1000)]],
      [500, g.B2.principal, [manualFee({ currency: 'USD', total: 10, your_share: 4, reason: 'Payoneer statement', gross: 500 }), npsb]],
      [300, g.B3.principal, [binance(300)]],
    ] as const).entries()) {
      const b = await rpc('post_usd_purchase', {
        p_actor: null, p_source_id: sourceId, p_gross_usd: gross, p_bdt_principal: Number(principal),
        p_fees: fees, p_purchased_at: at(1 + i), p_method: null, p_external_reference: null, p_notes: tag,
      })
      batches.push(b.id as string)
    }

    const { data: accts, error: aErr } = await admin
      .from('ad_accounts')
      .insert([
        { name: `ZZ P prepaid ${SUFFIX}`, platform: 'META', is_platform: true, organization_id: null },
        { name: `ZZ Q postpaid ${SUFFIX}`, platform: 'META', is_platform: true, organization_id: null },
      ])
      .select('id, name')
    if (aErr) throw new Error(aErr.message)
    P = accts!.find((a) => a.name.includes(' P '))!.id
    Q = accts!.find((a) => a.name.includes(' Q '))!.id
  }, 90_000)

  afterAll(async () => {
    if (!admin) return
    const { data: spends } = await admin
      .from('meta_spend_events')
      .select('id')
      .in('ad_account_id', [P, Q].filter(Boolean))
      .eq('status', 'POSTED')
    for (const s of spends ?? []) {
      await admin.rpc('reverse_meta_spend', { p_actor: null, p_event: s.id, p_reason: 'test cleanup' })
    }
    for (const id of [...outflows].reverse()) {
      await admin.rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: id, p_reason: 'test cleanup' })
    }
    for (const id of batches) {
      await admin.rpc('reverse_usd_purchase', { p_actor: null, p_purchase_id: id, p_reason: 'test cleanup' })
    }
    if (drainId) await admin.rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: drainId, p_reason: 'test cleanup' })
    const { data: open } = await admin.from('meta_spend_exceptions').select('id').in('ad_account_id', [P, Q].filter(Boolean)).is('resolved_at', null)
    for (const x of open ?? []) {
      await admin.rpc('resolve_meta_spend_exception', { p_actor: null, p_id: x.id, p_note: 'test cleanup' })
    }
    if (P || Q) await admin.from('ad_accounts').delete().in('id', [P, Q].filter(Boolean))
    if (sourceId) await admin.from('usd_sources').update({ is_active: false }).eq('id', sourceId)
  }, 90_000)

  it('pool accounts start postpaid; only a prepaid account can be funded', async () => {
    expect((await position(P)).owed).toBe('0.00')
    await expect(outflow('META_PREPAID_FUNDING', 700, P, 10)).rejects.toThrow(/^NOT_PREPAID/)
    expect((await rpc('set_meta_billing_mode', { p_actor: null, p_account: P, p_mode: 'META_PREPAID' })).changed).toBe(true)
  })

  it('funding P draws FIFO from inventory into P’s own lot (golden ৳88,200.88)', async () => {
    const f = await outflow('META_PREPAID_FUNDING', 700, P, 10)
    outflows.push(f.id as string)
    expect(dec(f.bdt_cost as number).toFixed(2)).toBe(GOLDEN.prepaidFunding.bdt)
    expect(await position(P)).toMatchObject({ funded: '700.00', left: '700.00', leftBdt: GOLDEN.prepaidFunding.bdt })
  })

  it('reads spend from Meta: first reading is the baseline, then the change is spend', async () => {
    const first = await reading({ [P]: 0, [Q]: 1000 }, 20)
    expect(first.baselined).toBeGreaterThanOrEqual(2)
    expect((await position(Q)).spent).toBe('0.00') // spend before tracking is not booked

    await reading({ [P]: 650, [Q]: 1450 }, 30)
    // Postpaid Q: owed to Meta in USD, no cost yet.
    expect(await position(Q)).toMatchObject({ spent: '450.00', owed: '450.00', paid: '0.00' })
    expect(dec((await lastSpend(Q)).bdt_cost as number).toFixed(2)).toBe('0.00')
    // Prepaid P: consumed its own lot (golden ৳81,900.82), $50 / ৳6,300.06 left.
    const p = await lastSpend(P)
    expect(dec(p.bdt_cost as number).toFixed(2)).toBe(GOLDEN.prepaidSpend.bdt)
    expect(await position(P)).toMatchObject({ spent: '650.00', left: '50.00', leftBdt: GOLDEN.prepaidSpend.left_bdt })
  })

  it('paying Q’s bill settles what is owed at FIFO cost (golden ৳57,235.82)', async () => {
    const bill = await outflow('META_BILL_PAYMENT', 450, Q, 40)
    outflows.push(bill.id as string)
    expect(dec(bill.bdt_cost as number).toFixed(2)).toBe(GOLDEN.postpaidSettlement.bdt)
    expect(await position(Q)).toMatchObject({ paid: '450.00', owed: '0.00' })
    const { data: inv } = await admin.from('usd_fifo_summary').select('left_usd, left_bdt').single()
    expect(dec(inv!.left_bdt).toFixed(2)).toBe(GOLDEN.closingInventory.bdt)
  })

  it('journal: prepaid funding and spend are posted; postpaid spend is not; cost = golden', async () => {
    const lines = async (type: string, id: string) => {
      const { data } = await admin
        .from('journal_entries')
        .select('lines:journal_lines(account_code, debit_bdt, credit_bdt)')
        .eq('source_type', type)
        .eq('source_id', id)
        .eq('is_reversal', false)
      return (data ?? []).flatMap((e) => (e.lines as Array<{ account_code: string; debit_bdt: number; credit_bdt: number }>)
        .map((l) => [l.account_code, dec(l.debit_bdt).toFixed(2), dec(l.credit_bdt).toFixed(2)])).sort()
    }
    expect(await lines('USD_OUTFLOW', outflows[0])).toEqual([['1200', '0.00', '88200.88'], ['1400', '88200.88', '0.00']])
    expect(await lines('META_SPEND', (await lastSpend(P)).id as string)).toEqual([['1400', '0.00', '81900.82'], ['5000', '81900.82', '0.00']])
    expect(await lines('META_SPEND', (await lastSpend(Q)).id as string)).toEqual([])
    // Cost recognised = prepaid spend + the postpaid bill: the golden figure.
    expect(dec(GOLDEN.prepaidSpend.bdt).plus(GOLDEN.postpaidSettlement.bdt).toFixed(2)).toBe(GOLDEN.grossProfit.cost_bdt)
  })

  it('guards: prepaid → postpaid refused while credit is left; spent funding cannot be reversed', async () => {
    await expect(rpc('set_meta_billing_mode', { p_actor: null, p_account: P, p_mode: 'META_POSTPAID' })).rejects.toThrow(/^PREPAID_LEFT/)
    await expect(rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: outflows[0], p_reason: 'x' })).rejects.toThrow(/^LOT_IN_USE/)
  })

  it('prepaid overspend: the lot covers what it can, the rest is flagged, never negative', async () => {
    await reading({ [P]: 730 }, 50)
    const e = await lastSpend(P)
    expect([dec(e.covered_usd as number).toFixed(2), dec(e.unfunded_usd as number).toFixed(2), dec(e.bdt_cost as number).toFixed(2)])
      .toEqual(['50.00', '30.00', GOLDEN.prepaidSpend.left_bdt])
    expect(await position(P)).toMatchObject({ left: '0.00', leftBdt: '0.00' })
    const { data: x } = await admin.from('meta_spend_exceptions').select('kind, usd').eq('ad_account_id', P).is('resolved_at', null)
    expect(x!.map((r) => [r.kind, dec(r.usd).toFixed(2)])).toEqual([['UNFUNDED_SPEND', '30.00']])
  })

  it('a drop in Meta’s figure is flagged, not booked; tracking restarts from it', async () => {
    await reading({ [Q]: 1400 }, 60)
    expect((await position(Q)).spent).toBe('450.00')
    const { data: x } = await admin.from('meta_spend_exceptions').select('kind, usd').eq('ad_account_id', Q).is('resolved_at', null)
    expect(x!.map((r) => [r.kind, dec(r.usd).toFixed(2)])).toEqual([['NEGATIVE_CHANGE', '50.00']])
    await reading({ [Q]: 1410 }, 70)
    expect(await position(Q)).toMatchObject({ spent: '460.00', owed: '10.00' })
  })

  it('reversing prepaid spend puts it back in the lot; the books tie to lots and FIFO', async () => {
    const e = await lastSpend(P)
    await rpc('reverse_meta_spend', { p_actor: null, p_event: e.id, p_reason: 'test' })
    expect(await position(P)).toMatchObject({ left: '50.00', leftBdt: GOLDEN.prepaidSpend.left_bdt })

    const { data: tb } = await admin.rpc('gl_trial_balance', { p_as_of: 'infinity' })
    const rows = tb as Array<{ code: string; balance_bdt: number; debit_bdt: number; credit_bdt: number }>
    const bal = (c: string) => dec(rows.find((r) => r.code === c)!.balance_bdt).toFixed(2)
    const { data: lots } = await admin.from('meta_prepaid_lot_balances').select('left_bdt').eq('status', 'POSTED')
    expect(bal('1400')).toBe((lots ?? []).reduce((s, l) => s.plus(l.left_bdt), dec(0)).toFixed(2))
    const { data: inv } = await admin.from('usd_fifo_summary').select('left_bdt').single()
    expect(bal('1200')).toBe(dec(inv!.left_bdt).toFixed(2))
    expect(rows.reduce((s, r) => s.plus(r.debit_bdt), dec(0)).toFixed(2)).toBe(rows.reduce((s, r) => s.plus(r.credit_bdt), dec(0)).toFixed(2))
  })
})

/**
 * Finance v2 agency billing (migration 000064): a throwaway agency with a
 * client on a granted POOL account. Approving its limit requests must bill it
 * at its rate (or wait for one); payments settle what is owed and turn the
 * rest into an advance that later charges use up; guards on reversals; an
 * opening balance; an agency-owned account is never billed; and a closed month
 * refuses postings. Everything is reversed after; the org and its accounts are
 * deleted (charges and payments survive with a NULL org, as designed).
 */
describe.skipIf(!creds)('Finance v2 agency billing (000064)', () => {
  let admin: SupabaseClient
  let org = ''
  let client = ''
  let pool = ''
  let own = ''
  let sourceId = ''
  const requests: Array<string> = []
  const payments: Array<string> = []
  const base = Date.now() + 4 * 60 * 60_000
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString()
  const dhakaDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  // A month that has certainly ended and that nothing else posts into.
  const PAST_MONTH = '2025-01-01'

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data as Record<string, unknown>
  }
  async function approve(account: string, usd: number, minutes: number) {
    const { data: asg } = await admin.from('ad_account_assignments').select('id').eq('ad_account_id', account).eq('status', 'ACTIVE').single()
    const { data: lr, error } = await admin
      .from('limit_requests')
      .insert({
        client_id: client, ad_account_id: account, organization_id: org, assignment_id: asg!.id,
        opening_balance_usd: 0, requested_amount_usd: usd, default_usd_rate: 120,
        expected_new_limit_usd: usd, status: 'PENDING', segment: 'postpaid', total_cost_bdt: usd * 120,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    requests.push(lr.id)
    const upd = await admin
      .from('limit_requests')
      .update({ status: 'APPROVED', approved_amount_usd: usd, approved_at: at(minutes) })
      .eq('id', lr.id)
    if (upd.error) throw new Error(upd.error.message)
    const { data: charge } = await admin.from('agency_charges').select('*').eq('limit_request_id', lr.id).maybeSingle()
    return charge as Record<string, unknown> | null
  }
  async function balance() {
    const b = await rpc('agency_balance', { p_org: org })
    return { owed: dec(b.owed_bdt as number).toFixed(2), advance: dec(b.advance_bdt as number).toFixed(2) }
  }
  const pay = async (bdt: number, minutes: number) => {
    const p = await rpc('record_agency_payment', {
      p_actor: null, p_org: org, p_bdt: bdt, p_received_at: at(minutes), p_method: 'DBBL',
      p_is_internal: false, p_reference: null, p_notes: null, p_key: `ab-${SUFFIX}-${Math.random()}`,
    })
    payments.push(p.id as string)
    return p
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    const { data: o, error: oErr } = await admin.from('organizations').insert({ name: `ZZ AB ${SUFFIX}`, subscription_status: 'active' }).select('id').single()
    if (oErr) throw new Error(oErr.message)
    org = o.id
    const { data: c, error: cErr } = await admin.from('clients').insert({ name: `ZZ AB client ${SUFFIX}`, organization_id: org, segment: 'postpaid' }).select('id').single()
    if (cErr) throw new Error(cErr.message)
    client = c.id
    const { data: a, error: aErr } = await admin
      .from('ad_accounts')
      .insert([
        { name: `ZZ AB pool ${SUFFIX}`, platform: 'META', status: 'ACTIVE', is_platform: true, organization_id: null, usd_rate: 0 },
        { name: `ZZ AB own ${SUFFIX}`, platform: 'META', status: 'ACTIVE', is_platform: false, organization_id: org, usd_rate: 0 },
      ])
      .select('id, name')
    if (aErr) throw new Error(aErr.message)
    pool = a!.find((r) => r.name.includes(' pool '))!.id
    own = a!.find((r) => r.name.includes(' own '))!.id
    const g = await admin.from('platform_account_grants').insert({ ad_account_id: pool, organization_id: org })
    if (g.error) throw new Error(g.error.message)
    const s = await admin.from('ad_account_assignments').insert([
      { ad_account_id: pool, client_id: client, opening_limit_usd: 0, organization_id: org },
      { ad_account_id: own, client_id: client, opening_limit_usd: 0, organization_id: org },
    ])
    if (s.error) throw new Error(s.error.message)
    const { data: src } = await admin.from('usd_sources').insert({ name: `ZZ-AB-${SUFFIX}`, payment_method: 'Binance', receiving_institution: 'DBBL' }).select('id').single()
    sourceId = src!.id
  }, 90_000)

  afterAll(async () => {
    if (!admin) return
    await admin.rpc('reopen_finance_period', { p_actor: null, p_month: PAST_MONTH, p_reason: 'test cleanup' })
    for (const id of [...payments].reverse()) {
      await admin.rpc('reverse_agency_payment', { p_actor: null, p_id: id, p_reason: 'test cleanup' })
    }
    const { data: charges } = await admin.from('agency_charges').select('id').eq('organization_id', org).neq('status', 'REVERSED').order('event_at', { ascending: false })
    for (const c of charges ?? []) {
      await admin.rpc('reverse_agency_charge', { p_actor: null, p_id: c.id, p_reason: 'test cleanup' })
    }
    if (requests.length) await admin.from('limit_requests').delete().in('id', requests)
    await admin.from('audit_logs').delete().eq('organization_id', org)
    await admin.from('ad_account_assignments').delete().in('ad_account_id', [pool, own].filter(Boolean))
    if (pool) await admin.from('platform_account_grants').delete().eq('ad_account_id', pool)
    await admin.from('ad_accounts').delete().in('id', [pool, own].filter(Boolean))
    if (client) await admin.from('clients').delete().eq('id', client)
    if (org) await admin.from('organizations').delete().eq('id', org)
    if (sourceId) await admin.from('usd_sources').update({ is_active: false }).eq('id', sourceId)
  }, 90_000)

  it('an approval with no rate waits; setting the rate bills it and posts the journal', async () => {
    const c = await approve(pool, 100, 10)
    expect(c).toMatchObject({ status: 'PENDING_RATE', bdt_amount: null })
    expect(await balance()).toEqual({ owed: '0.00', advance: '0.00' })

    const r = await rpc('set_agency_rate', { p_actor: null, p_org: org, p_rate: 130, p_from: dhakaDay(at(10)), p_note: null })
    expect(r.priced).toBe(1)
    expect(await balance()).toEqual({ owed: '13000.00', advance: '0.00' })
    const { data: je } = await admin
      .from('journal_entries')
      .select('lines:journal_lines(account_code, debit_bdt, credit_bdt, party_org_id)')
      .eq('source_type', 'AGENCY_CHARGE').eq('source_id', c!.id as string).single()
    const lines = (je!.lines as Array<{ account_code: string; debit_bdt: number; credit_bdt: number; party_org_id: string | null }>)
      .map((l) => [l.account_code, dec(l.debit_bdt).toFixed(2), dec(l.credit_bdt).toFixed(2), l.party_org_id]).sort()
    expect(lines).toEqual([['1300', '13000.00', '0.00', org], ['4000', '0.00', '13000.00', null]])
  })

  it('an approval on the agency’s own account is never billed', async () => {
    expect(await approve(own, 50, 15)).toBeNull()
  })

  it('a payment settles what is owed; the rest is an advance the next approval uses', async () => {
    const p = await pay(20000, 20)
    expect([dec(p.applied_bdt as number).toFixed(2), dec(p.advance_bdt as number).toFixed(2)]).toEqual(['13000.00', '7000.00'])
    expect(await balance()).toEqual({ owed: '0.00', advance: '7000.00' })

    const c = await approve(pool, 40, 30) // 40 × 130 = 5,200, paid from the advance
    expect(dec(c!.bdt_amount as number).toFixed(2)).toBe('5200.00')
    expect(await balance()).toEqual({ owed: '0.00', advance: '1800.00' })
    const { count } = await admin.from('journal_entries').select('id', { count: 'exact', head: true })
      .eq('source_type', 'AGENCY_ADVANCE_APPLIED').eq('source_id', c!.id as string)
    expect(count).toBe(1)
  })

  it('a payment whose advance was used can’t be reversed until that charge is', async () => {
    await expect(rpc('reverse_agency_payment', { p_actor: null, p_id: payments[0], p_reason: 'x' })).rejects.toThrow(/^PAYMENT_APPLIED/)
    const { data: c } = await admin.from('agency_charges').select('id').eq('organization_id', org).eq('usd_amount', 40).single()
    await rpc('reverse_agency_charge', { p_actor: null, p_id: c!.id, p_reason: 'test' })
    expect(await balance()).toEqual({ owed: '0.00', advance: '7000.00' })
    await rpc('reverse_agency_payment', { p_actor: null, p_id: payments.shift()!, p_reason: 'test' })
    expect(await balance()).toEqual({ owed: '13000.00', advance: '0.00' })
  })

  it('a new rate applies from its start date; earlier charges keep theirs', async () => {
    await rpc('set_agency_rate', { p_actor: null, p_org: org, p_rate: 135, p_from: dhakaDay(at(3 * 24 * 60)), p_note: null })
    const later = await approve(pool, 10, 4 * 24 * 60)
    expect([dec(later!.rate as number).toFixed(2), dec(later!.bdt_amount as number).toFixed(2)]).toEqual(['135.00', '1350.00'])
    const { data: first } = await admin.from('agency_charges').select('rate').eq('organization_id', org).eq('usd_amount', 100).single()
    expect(dec(first!.rate).toFixed(2)).toBe('130.00')
    await expect(rpc('set_agency_rate', { p_actor: null, p_org: org, p_rate: 140, p_from: dhakaDay(at(3 * 24 * 60)), p_note: null })).rejects.toThrow(/^DUPLICATE/)
  })

  it('opening balance: owed before go-live, once per agency, not revenue', async () => {
    const before = await balance()
    await rpc('record_agency_opening_balance', { p_actor: null, p_org: org, p_bdt: 5000, p_as_of: at(5), p_notes: 'test' })
    expect((await balance()).owed).toBe(dec(before.owed).plus(5000).toFixed(2))
    await expect(rpc('record_agency_opening_balance', { p_actor: null, p_org: org, p_bdt: 1, p_as_of: at(5), p_notes: 'x' })).rejects.toThrow(/^DUPLICATE/)
    const { data: c } = await admin.from('agency_charges').select('id').eq('organization_id', org).eq('kind', 'OPENING_BALANCE').single()
    const { data: je } = await admin.from('journal_entries').select('lines:journal_lines(account_code)').eq('source_type', 'AGENCY_CHARGE').eq('source_id', c!.id).single()
    expect((je!.lines as Array<{ account_code: string }>).map((l) => l.account_code).sort()).toEqual(['1300', '3000'])
  })

  it('the billing summary agrees with the journal', async () => {
    const { data: s } = await admin.from('agency_billing_summary').select('*').eq('organization_id', org).single()
    const b = await balance()
    expect([dec(s!.owed_bdt).toFixed(2), dec(s!.advance_bdt).toFixed(2)]).toEqual([b.owed, b.advance])
    // 135 starts in the future. 130 starts on the Dhaka day of base + 10 min,
    // and base is 4 h ahead — after ~19:50 Dhaka that is tomorrow, so no rate
    // is in effect yet today.
    const today = dhakaDay(new Date().toISOString())
    const expected = dhakaDay(at(10)) <= today ? '130.00' : null
    expect(s!.current_rate == null ? null : dec(s!.current_rate).toFixed(2)).toBe(expected)
  })

  it('a closed month refuses postings dated in it; the current month can’t be closed; reopening needs a reason', async () => {
    const now = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }).slice(0, 7) + '-01'
    await expect(rpc('close_finance_period', { p_actor: null, p_month: now })).rejects.toThrow(/^PERIOD_NOT_OVER/)
    await rpc('close_finance_period', { p_actor: null, p_month: PAST_MONTH })
    // A payment has no backdating guard of its own, so this is the period check.
    await expect(rpc('record_agency_payment', {
      p_actor: null, p_org: org, p_bdt: 100, p_received_at: '2025-01-15T10:00:00+06:00', p_method: null,
      p_is_internal: false, p_reference: null, p_notes: null, p_key: `ab-closed-${SUFFIX}`,
    })).rejects.toThrow(/^PERIOD_CLOSED/)
    await expect(rpc('reopen_finance_period', { p_actor: null, p_month: PAST_MONTH, p_reason: ' ' })).rejects.toThrow(/^REASON_REQUIRED/)
    await rpc('reopen_finance_period', { p_actor: null, p_month: PAST_MONTH, p_reason: 'test' })
  })
})

/**
 * Finance v2 close-out (migration 000065): prepaid credit returned to stock or
 * written off (golden account P: $50 / ৳6,300.06 left after spending $650),
 * the guards and reversals, the opening bank balance, reconciliation against
 * the books, and the profit report for this test's own time window.
 */
describe.skipIf(!creds)('Finance v2 close-out (000065)', () => {
  let admin: SupabaseClient
  let sourceId = ''
  let drainId: string | null = null
  let P = ''
  let fundingId = ''
  let spendId = ''
  const batches: Array<string> = []
  const base = Date.now() + 6 * 60 * 60_000
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString()
  const tag = `close-${SUFFIX}`

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data as Record<string, unknown>
  }
  async function left() {
    const { data } = await admin.from('meta_prepaid_lot_balances').select('left_usd, left_bdt').eq('ad_account_id', P).eq('status', 'POSTED')
    return {
      usd: (data ?? []).reduce((s, l) => s.plus(l.left_usd), dec(0)).toFixed(2),
      bdt: (data ?? []).reduce((s, l) => s.plus(l.left_bdt), dec(0)).toFixed(2),
    }
  }
  async function entryLines(type: string, id: string) {
    const { data } = await admin
      .from('journal_entries')
      .select('lines:journal_lines(account_code, debit_bdt, credit_bdt)')
      .eq('source_type', type).eq('source_id', id).eq('is_reversal', false)
    return (data ?? []).flatMap((e) => (e.lines as Array<{ account_code: string; debit_bdt: number; credit_bdt: number }>)
      .map((l) => [l.account_code, dec(l.debit_bdt).toFixed(2), dec(l.credit_bdt).toFixed(2)])).sort()
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    // A failed earlier run may have left an opening bank balance live.
    await admin.rpc('reverse_opening_bank', { p_actor: null, p_reason: 'test reset' })
    const { data: src } = await admin.from('usd_sources').insert({ name: `ZZ-CLOSE-${SUFFIX}`, payment_method: 'Binance', receiving_institution: 'DBBL' }).select('id').single()
    sourceId = src!.id
    const { data: inv } = await admin.from('usd_fifo_summary').select('left_usd').single()
    if (dec(inv!.left_usd).gt(0)) {
      drainId = (await rpc('post_usd_outflow', {
        p_actor: null, p_kind: 'OTHER', p_usd: dec(inv!.left_usd).toNumber(), p_event_at: at(0),
        p_ad_account_id: null, p_idempotency_key: `close-drain-${SUFFIX}`, p_notes: tag,
      })).id as string
    }
    const binance = resolveFeeRule(defaultFeeRules('2020-01-01'), { channel: 'BINANCE', from_institution: 'Binance', to_institution: 'Binance', date: '2026-10-20', transfer_amount: 1000 })
    batches.push((await rpc('post_usd_purchase', {
      p_actor: null, p_source_id: sourceId, p_gross_usd: 1000, p_bdt_principal: Number(GOLDEN.batches.B1.principal),
      p_fees: [binance], p_purchased_at: at(1), p_method: null, p_external_reference: null, p_notes: tag,
    })).id as string)
    const { data: acct } = await admin.from('ad_accounts').insert({ name: `ZZ close P ${SUFFIX}`, platform: 'META', is_platform: true, organization_id: null }).select('id').single()
    P = acct!.id
    await rpc('set_meta_billing_mode', { p_actor: null, p_account: P, p_mode: 'META_PREPAID' })
    fundingId = (await rpc('post_usd_outflow', {
      p_actor: null, p_kind: 'META_PREPAID_FUNDING', p_usd: 700, p_event_at: at(2),
      p_ad_account_id: P, p_idempotency_key: null, p_notes: tag,
    })).id as string
    spendId = (await rpc('record_manual_meta_spend', {
      p_actor: null, p_account: P, p_usd: 650, p_event_at: at(3), p_notes: tag, p_key: `close-spend-${SUFFIX}`,
    })).id as string
  }, 90_000)

  afterAll(async () => {
    if (!admin) return
    const { data: adj } = await admin.from('meta_prepaid_adjustments').select('group_id').eq('ad_account_id', P).eq('status', 'POSTED')
    for (const g of new Set((adj ?? []).map((a) => a.group_id))) {
      await admin.rpc('reverse_prepaid_adjustment', { p_actor: null, p_group: g, p_reason: 'test cleanup' })
    }
    if (spendId) await admin.rpc('reverse_meta_spend', { p_actor: null, p_event: spendId, p_reason: 'test cleanup' })
    if (fundingId) await admin.rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: fundingId, p_reason: 'test cleanup' })
    for (const id of batches) await admin.rpc('reverse_usd_purchase', { p_actor: null, p_purchase_id: id, p_reason: 'test cleanup' })
    if (drainId) await admin.rpc('reverse_usd_outflow', { p_actor: null, p_outflow_id: drainId, p_reason: 'test cleanup' })
    await admin.rpc('reverse_opening_bank', { p_actor: null, p_reason: 'test cleanup' })
    if (P) await admin.from('ad_accounts').delete().eq('id', P)
    if (sourceId) await admin.from('usd_sources').update({ is_active: false }).eq('id', sourceId)
  }, 90_000)

  it('starts from the golden prepaid position: $50 / ৳6,300.06 left', async () => {
    expect(await left()).toEqual({ usd: '50.00', bdt: GOLDEN.prepaidSpend.left_bdt })
  })

  it('returns credit to stock as a new batch at the lot’s cost; the batch can’t be reversed directly', async () => {
    const before = await admin.from('usd_fifo_summary').select('left_usd, left_bdt').single()
    const r = await rpc('adjust_prepaid_credit', { p_actor: null, p_account: P, p_kind: 'RETURN', p_usd: 30, p_reason: tag })
    // 30 × 6,300.06 ÷ 50 = 3,780.036 → 3,780.04
    expect(dec(r.bdt as number).toFixed(2)).toBe('3780.04')
    expect(await left()).toEqual({ usd: '20.00', bdt: '2520.02' })
    const after = await admin.from('usd_fifo_summary').select('left_usd, left_bdt').single()
    expect(dec(after.data!.left_usd).minus(before.data!.left_usd).toFixed(2)).toBe('30.00')
    expect(dec(after.data!.left_bdt).minus(before.data!.left_bdt).toFixed(2)).toBe('3780.04')
    expect(await entryLines('USD_PURCHASE', r.return_batch_id as string)).toEqual([['1200', '3780.04', '0.00'], ['1400', '0.00', '3780.04']])
    await expect(rpc('reverse_usd_purchase', { p_actor: null, p_purchase_id: r.return_batch_id, p_reason: 'x' })).rejects.toThrow(/^RETURN_BATCH/)
    await expect(rpc('set_meta_billing_mode', { p_actor: null, p_account: P, p_mode: 'META_POSTPAID' })).rejects.toThrow(/^PREPAID_LEFT/)
  })

  it('writes off the rest at exactly what is left; more than is left is refused', async () => {
    await expect(rpc('adjust_prepaid_credit', { p_actor: null, p_account: P, p_kind: 'WRITE_OFF', p_usd: 20.01, p_reason: tag })).rejects.toThrow(/^INSUFFICIENT_INVENTORY/)
    await expect(rpc('adjust_prepaid_credit', { p_actor: null, p_account: P, p_kind: 'WRITE_OFF', p_usd: 20, p_reason: ' ' })).rejects.toThrow(/^REASON_REQUIRED/)
    const w = await rpc('adjust_prepaid_credit', { p_actor: null, p_account: P, p_kind: 'WRITE_OFF', p_usd: 20, p_reason: tag })
    expect(dec(w.bdt as number).toFixed(2)).toBe('2520.02')
    expect(await left()).toEqual({ usd: '0.00', bdt: '0.00' })
    const { data: rows } = await admin.from('meta_prepaid_adjustments').select('id').eq('group_id', w.group_id as string)
    expect(await entryLines('PREPAID_ADJUSTMENT', rows![0].id)).toEqual([['1400', '0.00', '2520.02'], ['5800', '2520.02', '0.00']])
  })

  it('the profit report: prepaid spend in its window; the write-off when it was made', async () => {
    // Exactly this run's spend instant: runs minutes apart have overlapping
    // future windows, and an earlier run's spend stays in its own window.
    const r = await rpc('finance_profit_report', { p_from: at(3), p_to: at(3.001) })
    expect(dec(r.meta_cost_bdt as number).toFixed(2)).toBe(GOLDEN.prepaidSpend.bdt)
    expect(dec(r.gross_profit_bdt as number).toFixed(2)).toBe(dec(r.revenue_bdt as number).minus(GOLDEN.prepaidSpend.bdt).toFixed(2))
    // A write-off is dated when it is made (now), not in the spend's window.
    const now = await rpc('finance_profit_report', {
      p_from: new Date(Date.now() - 10 * 60_000).toISOString(),
      p_to: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    expect(dec(now.write_off_bdt as number).toFixed(2)).toBe('2520.02')
    const agencies = r.agencies as Array<{ name: string; spend_usd: number }>
    expect(agencies.find((a) => a.name === 'Not held by an agency')?.spend_usd).toBe(650)
  })

  it('reversing the write-off and the return gives the credit back and takes the batch out of stock', async () => {
    const { data: adj } = await admin.from('meta_prepaid_adjustments').select('group_id, kind').eq('ad_account_id', P).eq('status', 'POSTED')
    const wo = adj!.find((a) => a.kind === 'WRITE_OFF')!.group_id
    const ret = adj!.find((a) => a.kind === 'RETURN')!.group_id
    await rpc('reverse_prepaid_adjustment', { p_actor: null, p_group: wo, p_reason: 'test' })
    expect(await left()).toEqual({ usd: '20.00', bdt: '2520.02' })
    await rpc('reverse_prepaid_adjustment', { p_actor: null, p_group: ret, p_reason: 'test' })
    expect(await left()).toEqual({ usd: '50.00', bdt: GOLDEN.prepaidSpend.left_bdt })
    await expect(rpc('reverse_prepaid_adjustment', { p_actor: null, p_group: ret, p_reason: 'test' })).rejects.toThrow(/^ALREADY_REVERSED/)
  })

  it('opening bank balance: once, posted against opening equity', async () => {
    const o = await rpc('record_opening_bank', { p_actor: null, p_bdt: 250000, p_as_of: at(4), p_notes: tag })
    expect(await entryLines('OPENING_BANK', o.id as string)).toEqual([['1010', '250000.00', '0.00'], ['3000', '0.00', '250000.00']])
    await expect(rpc('record_opening_bank', { p_actor: null, p_bdt: 1, p_as_of: at(4), p_notes: tag })).rejects.toThrow(/^DUPLICATE/)
  })

  it('reconciliation: matched within ৳1, a difference stays open until explained', async () => {
    const probe = await rpc('record_reconciliation', { p_actor: null, p_scope: 'BANK', p_as_of: at(5), p_actual: 0, p_details: [], p_note: tag })
    const expected = dec(probe.expected as number)
    await rpc('resolve_reconciliation', { p_actor: null, p_id: probe.id, p_note: 'probe' })
    const ok = await rpc('record_reconciliation', { p_actor: null, p_scope: 'BANK', p_as_of: at(5), p_actual: expected.plus(0.5).toNumber(), p_details: [], p_note: tag })
    expect(ok.status).toBe('MATCHED')
    const off = await rpc('record_reconciliation', { p_actor: null, p_scope: 'BANK', p_as_of: at(5), p_actual: expected.plus(500).toNumber(), p_details: [], p_note: tag })
    expect([off.status, dec(off.difference as number).toFixed(2)]).toEqual(['DIFFERENCE', '500.00'])
    await expect(rpc('resolve_reconciliation', { p_actor: null, p_id: off.id, p_note: '' })).rejects.toThrow(/^REASON_REQUIRED/)
    expect((await rpc('resolve_reconciliation', { p_actor: null, p_id: off.id, p_note: 'test' })).status).toBe('RESOLVED')

    const { data: inv } = await admin.from('usd_fifo_summary').select('left_usd').single()
    const wallets = await rpc('record_reconciliation', {
      p_actor: null, p_scope: 'USD_WALLETS', p_as_of: new Date().toISOString(), p_actual: dec(inv!.left_usd).toDecimalPlaces(2).toNumber(),
      p_details: [{ wallet: 'Binance', usd: dec(inv!.left_usd).toNumber() }], p_note: tag,
    })
    expect(wallets.status).toBe('MATCHED')
  })
})
