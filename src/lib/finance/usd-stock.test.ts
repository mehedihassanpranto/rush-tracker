import { describe, expect, it } from 'vitest'
import { computeSourceWiseStock } from './usd-stock'
import type { PurchaseLot, SourceRef } from './usd-stock'

const S1: SourceRef = { id: 's1', name: 'S1', payment_method: 'Payoneer', is_active: true }
const S2: SourceRef = { id: 's2', name: 'S2', payment_method: 'Wise', is_active: true }
const S3: SourceRef = { id: 's3', name: 'S3', payment_method: null, is_active: false }

function lot(
  source_id: string,
  usd: number,
  bdt: number,
  purchased_at: string,
): PurchaseLot {
  return { source_id, usd_amount: usd, bdt_amount: bdt, purchased_at }
}

function row(result: ReturnType<typeof computeSourceWiseStock>, id: string) {
  const r = result.rows.find((x) => x.source_id === id)
  if (!r) throw new Error(`no row for ${id}`)
  return r
}

describe('computeSourceWiseStock (FIFO source depletion, spec §6.3)', () => {
  it('leaves everything remaining when nothing has been sold', () => {
    const out = computeSourceWiseStock(
      [S1, S2],
      [lot('s1', 1000, 120000, '2026-01-01T00:00:00Z'), lot('s2', 500, 61000, '2026-01-02T00:00:00Z')],
      0,
    )
    expect(row(out, 's1')).toMatchObject({ purchased_usd: '1000.00', allocated_usd: '0.00', remaining_usd: '1000.00' })
    expect(row(out, 's2')).toMatchObject({ purchased_usd: '500.00', allocated_usd: '0.00', remaining_usd: '500.00' })
    expect(out.oversold_usd).toBe('0.00')
  })

  it('spends the oldest purchase first, even across sources', () => {
    // S1 bought first (1000), S2 second (500). 1200 sold: all of S1's lot and
    // 200 of S2's, not a proportional split.
    const out = computeSourceWiseStock(
      [S1, S2],
      [lot('s1', 1000, 120000, '2026-01-01T00:00:00Z'), lot('s2', 500, 61000, '2026-01-02T00:00:00Z')],
      1200,
    )
    expect(row(out, 's1')).toMatchObject({ allocated_usd: '1000.00', remaining_usd: '0.00' })
    expect(row(out, 's2')).toMatchObject({ allocated_usd: '200.00', remaining_usd: '300.00' })
  })

  it('orders by purchase time, not by the order rows were supplied in', () => {
    // Same data as above but supplied newest-first: the answer must not change.
    const out = computeSourceWiseStock(
      [S1, S2],
      [lot('s2', 500, 61000, '2026-01-02T00:00:00Z'), lot('s1', 1000, 120000, '2026-01-01T00:00:00Z')],
      1200,
    )
    expect(row(out, 's1').remaining_usd).toBe('0.00')
    expect(row(out, 's2').remaining_usd).toBe('300.00')
  })

  it('keeps supplied order for identical timestamps', () => {
    const t = '2026-03-01T00:00:00Z'
    const out = computeSourceWiseStock(
      [S1, S2],
      [lot('s2', 100, 12000, t), lot('s1', 100, 12000, t)],
      100,
    )
    expect(row(out, 's2').allocated_usd).toBe('100.00')
    expect(row(out, 's1').allocated_usd).toBe('0.00')
  })

  it('depletes a source that has several purchases interleaved with another', () => {
    const out = computeSourceWiseStock(
      [S1, S2],
      [
        lot('s1', 100, 12000, '2026-01-01T00:00:00Z'),
        lot('s2', 100, 12200, '2026-01-02T00:00:00Z'),
        lot('s1', 100, 12400, '2026-01-03T00:00:00Z'),
      ],
      250,
    )
    // Jan 1 (S1) and Jan 2 (S2) fully spent, 50 of Jan 3 (S1).
    expect(row(out, 's1')).toMatchObject({ purchased_usd: '200.00', allocated_usd: '150.00', remaining_usd: '50.00' })
    expect(row(out, 's2')).toMatchObject({ purchased_usd: '100.00', allocated_usd: '100.00', remaining_usd: '0.00' })
  })

  it('reports dollars sold beyond everything bought instead of hiding them', () => {
    const out = computeSourceWiseStock(
      [S1],
      [lot('s1', 100, 12000, '2026-01-01T00:00:00Z')],
      130,
    )
    expect(row(out, 's1')).toMatchObject({ allocated_usd: '100.00', remaining_usd: '0.00' })
    expect(out.oversold_usd).toBe('30.00')
  })

  it('never lets remaining go negative, whatever was sold', () => {
    const out = computeSourceWiseStock([S1, S2], [lot('s1', 50, 6000, '2026-01-01T00:00:00Z')], 9999)
    for (const r of out.rows) expect(Number(r.remaining_usd)).toBeGreaterThanOrEqual(0)
  })

  it('keeps remaining across sources equal to purchased minus sold when not oversold', () => {
    const purchases = [
      lot('s1', 1000.5, 120060, '2026-01-01T00:00:00Z'),
      lot('s2', 250.25, 30530.5, '2026-01-05T00:00:00Z'),
      lot('s1', 75.1, 9200, '2026-02-01T00:00:00Z'),
    ]
    const sold = 600.75
    const out = computeSourceWiseStock([S1, S2], purchases, sold)
    const remaining = out.rows.reduce((sum, r) => sum + Number(r.remaining_usd), 0)
    expect(remaining).toBeCloseTo(1000.5 + 250.25 + 75.1 - sold, 6)
  })

  it('lists a source with no purchases with zeros and no rate', () => {
    const out = computeSourceWiseStock([S1, S3], [lot('s1', 10, 1200, '2026-01-01T00:00:00Z')], 0)
    expect(row(out, 's3')).toMatchObject({
      purchased_usd: '0.00',
      remaining_usd: '0.00',
      avg_buying_rate: null,
      is_active: false,
    })
  })

  it('reports a weighted-average buying rate per source, not a mean of rates', () => {
    // 100 USD at 120 and 300 USD at 124 -> (12000 + 37200) / 400 = 123, whereas
    // averaging the two rates would give 122.
    const out = computeSourceWiseStock(
      [S1],
      [lot('s1', 100, 12000, '2026-01-01T00:00:00Z'), lot('s1', 300, 37200, '2026-01-02T00:00:00Z')],
      0,
    )
    expect(row(out, 's1').avg_buying_rate).toBe('123.0000')
    expect(row(out, 's1').bdt_invested).toBe('49200.00')
  })

  it('is exact where floating point is not', () => {
    // 0.1 + 0.2 in binary floats is 0.30000000000000004; decimals must not drift.
    const out = computeSourceWiseStock(
      [S1],
      [lot('s1', 0.1, 12, '2026-01-01T00:00:00Z'), lot('s1', 0.2, 24, '2026-01-02T00:00:00Z')],
      0.3,
    )
    expect(row(out, 's1')).toMatchObject({ purchased_usd: '0.30', allocated_usd: '0.30', remaining_usd: '0.00' })
    expect(out.oversold_usd).toBe('0.00')
  })

  it('sorts sources by name with numbers in natural order', () => {
    const many: Array<SourceRef> = ['S10', 'S2', 'S1'].map((n) => ({
      id: n,
      name: n,
      payment_method: null,
      is_active: true,
    }))
    const out = computeSourceWiseStock(many, [], 0)
    expect(out.rows.map((r) => r.name)).toEqual(['S1', 'S2', 'S10'])
  })

  it('treats a negative sold total as zero', () => {
    const out = computeSourceWiseStock([S1], [lot('s1', 10, 1200, '2026-01-01T00:00:00Z')], -5)
    expect(row(out, 's1').allocated_usd).toBe('0.00')
  })

  it("carries each source's USD payment method through, including none", () => {
    const out = computeSourceWiseStock([S1, S2, S3], [], 0)
    expect(row(out, 's1').payment_method).toBe('Payoneer')
    expect(row(out, 's2').payment_method).toBe('Wise')
    expect(row(out, 's3').payment_method).toBeNull()
  })
})
