import { describe, expect, it } from 'vitest'
import {
  bankChannel,
  defaultFeeRules,
  manualFee,
  overrideFee,
  resolveFeeRule,
} from './fees'
import type { FeeRule, FeeRoute } from './fees'

const RULES = defaultFeeRules('2026-01-01')

const route = (over: Partial<FeeRoute>): FeeRoute => ({
  channel: 'NPSB',
  from_institution: 'DBBL',
  to_institution: 'BRAC',
  date: '2026-10-20',
  transfer_amount: 50000,
  ...over,
})

describe('resolveFeeRule (plan v2 fee tests 3–5)', () => {
  it('DBBL → DBBL is a matched rule with fee 0, not a missing fee', () => {
    const fee = resolveFeeRule(RULES, route({ channel: bankChannel('DBBL', 'dbbl'), to_institution: 'DBBL' }))
    expect(fee).toMatchObject({ source: 'RULE', rule_id: 'dbbl-internal', total: '0.00', your_share: '0.00' })
  })

  it('NPSB to another bank is BDT 10 flat, borne 100% by you', () => {
    expect(bankChannel('DBBL', 'BRAC')).toBe('NPSB')
    const fee = resolveFeeRule(RULES, route({}))
    expect(fee).toMatchObject({ rule_id: 'npsb-flat', currency: 'BDT', total: '10.00', your_share: '10.00', counterparty_share: '0.00' })
    // Flat: the amount transferred does not change it.
    expect(resolveFeeRule(RULES, route({ transfer_amount: 5 })).total).toBe('10.00')
  })

  it('Binance is USD 0.01 per transfer regardless of amount', () => {
    for (const amount of [100, 1000, 25000]) {
      const fee = resolveFeeRule(RULES, route({ channel: 'BINANCE', transfer_amount: amount }))
      expect(fee).toMatchObject({ currency: 'USD', total: '0.010000', your_share: '0.010000' })
    }
  })

  it('a route with no rule blocks instead of defaulting to zero', () => {
    // Same bank, but not Dutch-Bangla: no BANK_INTERNAL rule covers it.
    expect(() =>
      resolveFeeRule(RULES, route({ channel: bankChannel('BRAC', 'BRAC'), from_institution: 'BRAC' })),
    ).toThrow(/FEE_RULE_MISSING/)
    // Payoneer is manual-only.
    expect(() => resolveFeeRule(RULES, route({ channel: 'PAYONEER' }))).toThrow(/FEE_RULE_MISSING/)
  })

  it('uses the rule in force on the event date, so a later rule change never touches old transactions', () => {
    const rules: Array<FeeRule> = [
      { ...RULES[1], id: 'npsb-old', effective_to: '2026-06-30' },
      { ...RULES[1], id: 'npsb-new', amount: 15, effective_from: '2026-07-01' },
    ]
    expect(resolveFeeRule(rules, route({ date: '2026-06-30' }))).toMatchObject({ rule_id: 'npsb-old', total: '10.00' })
    expect(resolveFeeRule(rules, route({ date: '2026-07-01' }))).toMatchObject({ rule_id: 'npsb-new', total: '15.00' })
  })

  it('a named institution beats a wildcard; two equal matches are refused', () => {
    const special: FeeRule = { ...RULES[1], id: 'npsb-to-city', to_institution: 'CITY', amount: 5 }
    expect(resolveFeeRule([...RULES, special], route({ to_institution: 'City' })).rule_id).toBe('npsb-to-city')
    expect(() => resolveFeeRule([...RULES, { ...RULES[1], id: 'dup' }], route({}))).toThrow(/FEE_RULE_AMBIGUOUS/)
  })

  it('percentage and tiered rules, with a bearer split', () => {
    const pct: FeeRule = { ...RULES[1], id: 'pct', fee_type: 'PERCENT', percent: '1.5', your_share_pct: 40 }
    expect(resolveFeeRule([pct], route({ transfer_amount: 1000 }))).toMatchObject({ total: '15.00', your_share: '6.00', counterparty_share: '9.00' })
    const tiered: FeeRule = {
      ...RULES[1],
      id: 'tier',
      fee_type: 'TIERED',
      tiers: [{ up_to: 25000, amount: 5 }, { up_to: null, amount: 20 }],
    }
    expect(resolveFeeRule([tiered], route({ transfer_amount: 25000 })).total).toBe('5.00')
    expect(resolveFeeRule([tiered], route({ transfer_amount: 25000.01 })).total).toBe('20.00')
  })
})

describe('manualFee / overrideFee (plan v2 fee test 6)', () => {
  it('Payoneer: records your share and the supplier’s, supplier bears all by default', () => {
    expect(manualFee({ currency: 'USD', total: 10, your_share: 4, reason: 'Payoneer statement', gross: 500 })).toMatchObject({
      source: 'MANUAL',
      total: '10.000000',
      your_share: '4.000000',
      counterparty_share: '6.000000',
    })
    expect(manualFee({ currency: 'USD', total: 10, reason: 'Payoneer statement' }).your_share).toBe('0.000000')
  })

  it('validates shares, the gross cap and the reason', () => {
    expect(() => manualFee({ currency: 'USD', total: 10, your_share: 11, reason: 'x' })).toThrow(/FEE_INVALID/)
    expect(() => manualFee({ currency: 'USD', total: 10, your_share: -1, reason: 'x' })).toThrow(/FEE_INVALID/)
    expect(() => manualFee({ currency: 'USD', total: 600, reason: 'x', gross: 500 })).toThrow(/exceed/)
    expect(() => manualFee({ currency: 'USD', total: 1, reason: '  ' })).toThrow(/reason/)
  })

  it('an override needs a reason and keeps the rule’s original value beside it', () => {
    const rule = resolveFeeRule(RULES, route({}))
    const o = overrideFee(rule, { total: 0, your_share: 0, reason: 'Bank waived the fee this month' })
    expect(o).toMatchObject({ rule_id: 'npsb-flat', rule_total: '10.00', total: '0.00', reason: 'Bank waived the fee this month' })
    expect(() => overrideFee(rule, { total: 0, your_share: 0, reason: '' })).toThrow(/reason/)
  })
})
