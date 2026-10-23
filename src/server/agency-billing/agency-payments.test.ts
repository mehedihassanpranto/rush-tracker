import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dec } from '@/lib/money/money'
import { loadLiveTestEnv } from '@/test/live-env'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Agencies paying the platform (migration 000066) against staging: a
 * submission is approved into agency_payments through record_agency_payment
 * (settles what is owed, the rest becomes the agency's credit), dated when the
 * agency paid; review is one-shot; a rejection needs a reason; an agency can
 * only withdraw its own; a retried submit posts once; the public key reaches
 * none of it. Two throwaway agencies, reversed and deleted afterwards.
 */
const creds = loadLiveTestEnv()
const SUFFIX = `aptest-${Date.now()}`
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

describe.skipIf(!creds)('agency payments to the platform (000066)', () => {
  let admin: SupabaseClient
  let anon: SupabaseClient
  let org = ''
  let other = ''
  const payments: Array<string> = []
  let openingId = ''
  const paidAt = new Date(Date.now() - 60 * 60_000).toISOString()

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data as Record<string, unknown>
  }
  const submit = (o: string, bdt: number, key = `${SUFFIX}-${Math.random()}`) =>
    rpc('submit_agency_payment', {
      p_actor: null, p_org: o, p_bdt: bdt, p_method: 'DBBL transfer', p_reference: 'TX-1',
      p_paid_at: paidAt, p_note: 'test', p_key: key,
    })
  async function balance(o: string) {
    const b = await rpc('agency_balance', { p_org: o })
    return { owed: dec(b.owed_bdt as number).toFixed(2), advance: dec(b.advance_bdt as number).toFixed(2) }
  }

  beforeAll(async () => {
    admin = createClient(creds!.url, creds!.serviceKey, noSession)
    anon = createClient(creds!.url, creds!.anonKey, noSession)
    const { data, error } = await admin
      .from('organizations')
      .insert([
        { name: `ZZ AP ${SUFFIX}`, subscription_status: 'active' },
        { name: `ZZ AP other ${SUFFIX}`, subscription_status: 'active' },
      ])
      .select('id, name')
    if (error) throw new Error(error.message)
    org = data!.find((o) => !o.name.includes('other'))!.id
    other = data!.find((o) => o.name.includes('other'))!.id
    // What the agency owes: 13,000 from before go-live.
    openingId = (await rpc('record_agency_opening_balance', {
      p_actor: null, p_org: org, p_bdt: 13000, p_as_of: paidAt, p_notes: 'test',
    })).id as string
  }, 60_000)

  afterAll(async () => {
    if (!admin) return
    for (const id of payments) await admin.rpc('reverse_agency_payment', { p_actor: null, p_id: id, p_reason: 'test cleanup' })
    if (openingId) await admin.rpc('reverse_agency_charge', { p_actor: null, p_id: openingId, p_reason: 'test cleanup' })
    // Submissions go with their agency (ON DELETE CASCADE); booked payments
    // stay as platform history with a NULL organization.
    await admin.from('organizations').delete().in('id', [org, other].filter(Boolean))
  }, 60_000)

  it('validates a submission and posts nothing until it is approved', async () => {
    await expect(submit(org, 0)).rejects.toThrow(/^INVALID_AMOUNT/)
    await expect(submit(org, 10.005)).rejects.toThrow(/^INVALID_AMOUNT/)
    const s = await submit(org, 20000)
    expect(s).toMatchObject({ status: 'PENDING', duplicate: false })
    expect(await balance(org)).toEqual({ owed: '13000.00', advance: '0.00' })
  })

  it('a retried submit with the same key posts once — and never across agencies', async () => {
    const key = `${SUFFIX}-retry`
    const a = await submit(org, 500, key)
    const b = await submit(org, 500, key)
    expect(b).toMatchObject({ id: a.id, duplicate: true })
    await expect(submit(other, 500, key)).rejects.toThrow(/^NOT_FOUND/)
    await rpc('cancel_agency_payment_submission', { p_actor: null, p_org: org, p_id: a.id })
  })

  it('approving settles what is owed first and keeps the rest as credit, dated when paid', async () => {
    const { data: s } = await admin.from('agency_payment_submissions').select('id').eq('organization_id', org).eq('status', 'PENDING').eq('bdt_amount', 20000).single()
    const r = await rpc('approve_agency_payment_submission', { p_actor: null, p_id: s!.id, p_bdt: null })
    expect([dec(r.applied_bdt as number).toFixed(2), dec(r.advance_bdt as number).toFixed(2)]).toEqual(['13000.00', '7000.00'])
    expect(await balance(org)).toEqual({ owed: '0.00', advance: '7000.00' })
    const { data: pay } = await admin.from('agency_payments').select('id, received_at, submission_id').eq('id', r.agency_payment_id as string).single()
    payments.push(pay!.id)
    expect(pay!.submission_id).toBe(s!.id)
    expect(new Date(pay!.received_at).toISOString()).toBe(paidAt)
    await expect(rpc('approve_agency_payment_submission', { p_actor: null, p_id: s!.id, p_bdt: null })).rejects.toThrow(/^NOT_PENDING/)
  })

  it('the reviewer can approve the amount that actually arrived', async () => {
    const s = await submit(org, 1000)
    const r = await rpc('approve_agency_payment_submission', { p_actor: null, p_id: s.id, p_bdt: 950 })
    payments.push(r.agency_payment_id as string)
    expect(dec(r.approved_bdt as number).toFixed(2)).toBe('950.00')
    expect(await balance(org)).toEqual({ owed: '0.00', advance: '7950.00' })
  })

  it('a rejection needs a reason; an agency can only withdraw its own', async () => {
    const s = await submit(org, 300)
    await expect(rpc('reject_agency_payment_submission', { p_actor: null, p_id: s.id, p_reason: ' ' })).rejects.toThrow(/^REASON_REQUIRED/)
    await expect(rpc('cancel_agency_payment_submission', { p_actor: null, p_org: other, p_id: s.id })).rejects.toThrow(/^NOT_PENDING/)
    const r = await rpc('reject_agency_payment_submission', { p_actor: null, p_id: s.id, p_reason: 'No such transfer' })
    expect(r).toMatchObject({ status: 'REJECTED', rejection_reason: 'No such transfer' })
    await expect(rpc('cancel_agency_payment_submission', { p_actor: null, p_org: org, p_id: s.id })).rejects.toThrow(/^NOT_PENDING/)
    expect(await balance(org)).toEqual({ owed: '0.00', advance: '7950.00' })
  })

  it('the public key reaches none of it', async () => {
    const { data } = await anon.from('agency_payment_submissions').select('*').limit(1)
    expect(data ?? []).toEqual([])
    const { error } = await anon.rpc('submit_agency_payment', {
      p_actor: null, p_org: org, p_bdt: 1, p_method: 'x', p_reference: null, p_paid_at: paidAt, p_note: null, p_key: null,
    })
    expect(error).not.toBeNull()
  })
})
