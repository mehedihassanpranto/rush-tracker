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
