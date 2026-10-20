import { describe, expect, it } from 'vitest'
import { dec } from '@/lib/money/money'
import { GOLDEN } from './golden-dataset'
import { defaultFeeRules, manualFee, resolveFeeRule } from './fees'
import { allocateFifo, assertBatchReversible, consumePrepaidSpend } from './fifo'
import { computeBatchCost } from './usd-batch'
import type { FeeChannel } from './fees'
import type { Lot } from './fifo'

const RULES = defaultFeeRules('2026-01-01')
const fee = (channel: FeeChannel, from: string, to: string, amount: string) =>
  resolveFeeRule(RULES, {
    channel,
    from_institution: from,
    to_institution: to,
    date: '2026-10-20',
    transfer_amount: amount,
  })

describe('Finance v2 golden dataset — engine reproduces the hand-computed figures', () => {
  const g = GOLDEN
  const b1 = computeBatchCost({
    gross_usd: g.batches.B1.gross_usd,
    bdt_principal: g.batches.B1.principal,
    fees: [fee('BINANCE', 'BINANCE', 'BINANCE', '1000'), fee('BANK_INTERNAL', 'DBBL', 'DBBL', g.batches.B1.principal)],
  })
  const b2 = computeBatchCost({
    gross_usd: g.batches.B2.gross_usd,
    bdt_principal: g.batches.B2.principal,
    fees: [
      manualFee({ currency: 'USD', total: 10, your_share: 4, reason: 'Payoneer statement', gross: 500 }),
      fee('NPSB', 'DBBL', 'BRAC', g.batches.B2.principal),
    ],
  })
  const b3 = computeBatchCost({
    gross_usd: g.batches.B3.gross_usd,
    bdt_principal: g.batches.B3.principal,
    fees: [fee('BINANCE', 'BINANCE', 'BINANCE', '300'), fee('BANK_INTERNAL', 'DBBL', 'DBBL', g.batches.B3.principal)],
  })

  it('batch costs: exactly the taka that left your accounts; the supplier rate is the deal rate', () => {
    for (const [got, want] of [
      [b1, g.batches.B1],
      [b2, g.batches.B2],
      [b3, g.batches.B3],
    ] as const) {
      expect(got.net_usd).toBe(want.net_usd)
      expect(got.capitalized_fees_bdt).toBe(want.fees_bdt)
      expect(got.total_bdt_cost).toBe(want.cost)
      expect(got.supplier_rate).toBe(want.rate)
      expect(got.rate_warning).toBe(false)
    }
  })

  const inventory: Array<Lot> = [
    { id: 'B1', seq: 1, usd_left: b1.net_usd, bdt_left: b1.total_bdt_cost },
    { id: 'B2', seq: 2, usd_left: b2.net_usd, bdt_left: b2.total_bdt_cost },
    { id: 'B3', seq: 3, usd_left: b3.net_usd, bdt_left: b3.total_bdt_cost },
  ]
  const funding = allocateFifo(inventory, g.prepaidFunding.usd)
  const settlement = allocateFifo(funding.lots, g.postpaidSettlement.usd)
  const spend = consumePrepaidSpend(
    [{ id: 'P-lot-1', seq: 1, usd_left: funding.usd, bdt_left: funding.bdt }],
    g.prepaidSpend.usd,
  )

  it('prepaid funding takes B1 only', () => {
    expect(funding.bdt).toBe(g.prepaidFunding.bdt)
    expect(funding.lots[0]).toMatchObject({ usd_left: g.prepaidFunding.b1_left_usd, bdt_left: g.prepaidFunding.b1_left_bdt })
  })

  it('postpaid settlement splits across B1 and B2', () => {
    expect(settlement.allocations.map(({ lot_id, usd, bdt }) => ({ lot_id, usd, bdt }))).toEqual(g.postpaidSettlement.allocations)
    expect(settlement.bdt).toBe(g.postpaidSettlement.bdt)
  })

  it('prepaid spend consumes the account’s own lot; funded and spent stay two figures', () => {
    expect(spend).toMatchObject({ bdt: g.prepaidSpend.bdt, unfunded_usd: '0.000000' })
    expect(spend.lots[0]).toMatchObject({ usd_left: g.prepaidSpend.left_usd, bdt_left: g.prepaidSpend.left_bdt })
  })

  it('closing inventory = opening + purchases − consumption, to the paisa', () => {
    const usd = settlement.lots.reduce((s, l) => s.plus(l.usd_left), dec(0))
    const bdt = settlement.lots.reduce((s, l) => s.plus(l.bdt_left), dec(0))
    expect(usd.toFixed(6)).toBe(g.closingInventory.usd)
    expect(bdt.toFixed(2)).toBe(g.closingInventory.bdt)
    const { purchased_bdt, consumed_bdt } = g.closingInventory.reconciles
    expect(dec(purchased_bdt).minus(consumed_bdt).toFixed(2)).toBe(g.closingInventory.bdt)
    expect(dec(funding.bdt).plus(settlement.bdt).toFixed(2)).toBe(consumed_bdt)
  })

  it('revenue, receivables and gross profit (payment creates no revenue)', () => {
    const x = dec(g.revenue.clientX.usd).mul(g.revenue.clientX.rate)
    const y = dec(g.revenue.clientY.usd).mul(g.revenue.clientY.rate)
    expect(x.plus(y).toFixed(2)).toBe(g.revenue.total_bdt)
    expect(x.minus(50000).toFixed(2)).toBe(g.receivables.clientX_after_payment)
    const cost = dec(spend.bdt).plus(settlement.bdt)
    expect(cost.toFixed(2)).toBe(g.grossProfit.cost_bdt)
    expect(x.plus(y).minus(cost).toFixed(2)).toBe(g.grossProfit.profit_bdt)
    expect(dec(spend.lots[0].bdt_left).toFixed(2)).toBe(g.allocatedUnspent.cost_in_asset_bdt)
  })

  it('B4, posted by mistake and untouched, reverses cleanly; B1 cannot', () => {
    const b4 = computeBatchCost({
      gross_usd: g.batches.B4.gross_usd,
      bdt_principal: g.batches.B4.principal,
      fees: [fee('BINANCE', 'BINANCE', 'BINANCE', '100')],
    })
    expect(b4.total_bdt_cost).toBe(g.batches.B4.cost)
    expect(() => assertBatchReversible({ id: 'B4', net_usd: b4.net_usd, usd_left: b4.net_usd })).not.toThrow()
    expect(() => assertBatchReversible({ id: 'B1', net_usd: b1.net_usd, usd_left: settlement.lots[0].usd_left })).toThrow(/BATCH_CONSUMED/)
  })
})
