import { describe, expect, it } from 'vitest'
import Decimal from 'decimal.js'
import {
  allocateFifo,
  assertBatchReversible,
  assertPurchaseNotBackdated,
  consumePrepaidSpend,
} from './fifo'
import { computeBatchCost } from './usd-batch'
import { defaultFeeRules, resolveFeeRule } from './fees'
import type { Lot } from './fifo'

const lot = (id: string, seq: number, usd: string | number, bdt: string | number): Lot => ({
  id,
  seq,
  usd_left: usd,
  bdt_left: bdt,
})

describe('computeBatchCost (plan v2 fee tests 1, 7)', () => {
  const binance = resolveFeeRule(defaultFeeRules('2026-01-01'), {
    channel: 'BINANCE',
    from_institution: 'BINANCE',
    to_institution: 'BINANCE',
    date: '2026-10-20',
    transfer_amount: 100,
  })

  it('$100 with the $0.01 Binance fee nets $99.99; $1,000 nets $999.99', () => {
    expect(computeBatchCost({ gross_usd: 100, bdt_principal: 12700, fees: [binance] }).net_usd).toBe('99.990000')
    expect(computeBatchCost({ gross_usd: 1000, bdt_principal: 126000, fees: [binance] }).net_usd).toBe('999.990000')
  })

  it('never adds a USD fee on top: cost is the taka that left, the fee sits in the effective rate', () => {
    // Paid 100 × 127 = 12,700 for 99.99 landed.
    const c = computeBatchCost({ gross_usd: 100, bdt_principal: 12700, fees: [binance] })
    expect(c).toMatchObject({
      supplier_rate: '127.000000',
      capitalized_fees_bdt: '0.00',
      total_bdt_cost: '12700.00',
      effective_rate: '127.012701',
    })
    // Pure: recomputing (edit/retry/reopen) gives the same, never a second deduction.
    expect(computeBatchCost({ gross_usd: 100, bdt_principal: 12700, fees: [binance] })).toEqual(c)
  })

  it('a bank fee you bear is added once; the supplier’s share of a USD fee costs you nothing', () => {
    const npsb = { ...binance, rule_id: 'npsb', currency: 'BDT' as const, total: '10.00', your_share: '10.00', counterparty_share: '0.00', rule_total: '10.00' }
    const payoneer = { ...binance, source: 'MANUAL' as const, rule_id: null, total: '10.000000', your_share: '4.000000', counterparty_share: '6.000000', rule_total: null, reason: 'statement' }
    expect(computeBatchCost({ gross_usd: 500, bdt_principal: 63479, fees: [payoneer, npsb] })).toMatchObject({
      net_usd: '490.000000',
      supplier_rate: '128.500000',
      capitalized_fees_bdt: '10.00',
      total_bdt_cost: '63489.00',
    })
  })

  it('warns on a supplier rate outside 124–131 without blocking', () => {
    expect(computeBatchCost({ gross_usd: 100, bdt_principal: 13200, fees: [] }).rate_warning).toBe(true)
    expect(computeBatchCost({ gross_usd: 100, bdt_principal: 12300, fees: [] }).rate_warning).toBe(true)
    expect(computeBatchCost({ gross_usd: 100, bdt_principal: 12800, fees: [] }).rate_warning).toBe(false)
  })
})

describe('allocateFifo (plan v2 inventory tests 1, 3, 4, 5)', () => {
  it('consumes the oldest lot first and splits across lots', () => {
    const r = allocateFifo([lot('b2', 2, 500, 64000), lot('b1', 1, 100, 12600)], 150)
    expect(r.allocations.map((a) => [a.lot_id, a.usd, a.bdt])).toEqual([
      ['b1', '100.000000', '12600.00'],
      ['b2', '50.000000', '6400.00'],
    ])
    expect(r.bdt).toBe('19000.00')
  })

  it('orders by posting seq then id, not by input order', () => {
    const r = allocateFifo([lot('b', 1, 10, 1300), lot('a', 1, 10, 1260)], 5)
    expect(r.allocations[0].lot_id).toBe('a')
  })

  it('refuses to go negative', () => {
    expect(() => allocateFifo([lot('b1', 1, 100, 12600)], 100.01)).toThrow(/INSUFFICIENT_INVENTORY/)
  })

  it('rounding never strands a paisa: a lot’s allocations sum to its cost exactly', () => {
    // 100 USD for 12,345.67 BDT, drained in three uneven takes.
    let lots: Array<Lot> = [lot('b1', 1, 100, '12345.67')]
    const costs: Array<string> = []
    for (const take of [33.33, 33.33, 33.34]) {
      const r = allocateFifo(lots, take)
      costs.push(r.bdt)
      lots = r.lots
    }
    expect(costs.reduce((s, c) => s.plus(c), new Decimal(0)).toFixed(2)).toBe('12345.67')
    expect(lots[0]).toMatchObject({ usd_left: '0.000000', bdt_left: '0.00' })
  })
})

describe('prepaid Meta lots, backdating and reversal guards', () => {
  it('$700 funded and $650 spent stay separate; overspend is flagged, not negative', () => {
    const funded = [lot('p1', 1, 700, '88200.88')]
    const spend = consumePrepaidSpend(funded, 650)
    expect(spend).toMatchObject({ usd: '650.000000', unfunded_usd: '0.000000' })
    expect(spend.lots[0].usd_left).toBe('50.000000')

    const over = consumePrepaidSpend(spend.lots, 80)
    expect(over).toMatchObject({ usd: '50.000000', bdt: '6300.06', unfunded_usd: '30.000000' })
    expect(consumePrepaidSpend(over.lots, 5)).toMatchObject({ allocations: [], unfunded_usd: '5.000000' })
  })

  it('blocks a purchase dated before an already-consumed batch', () => {
    const batches = [
      { id: 'b1', event_date: '2026-10-01', consumed: true },
      { id: 'b2', event_date: '2026-10-10', consumed: false },
    ]
    expect(() => assertPurchaseNotBackdated('2026-09-30', batches)).toThrow(/BACKDATED_PURCHASE/)
    expect(() => assertPurchaseNotBackdated('2026-10-05', batches)).not.toThrow()
  })

  it('a purchase is reversible only while untouched', () => {
    expect(() => assertBatchReversible({ id: 'b4', net_usd: 99.99, usd_left: 99.99 })).not.toThrow()
    expect(() => assertBatchReversible({ id: 'b1', net_usd: 999.99, usd_left: 299.99 })).toThrow(/BATCH_CONSUMED/)
  })
})
