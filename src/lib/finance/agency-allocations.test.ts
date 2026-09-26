import { describe, expect, it } from 'vitest'
import {
  combineAllocation,
  latestOf,
  mergeAllocationHistory,
  totalTodayApprovals,
} from './agency-allocations'
import type { AllocationHistoryRow } from './agency-allocations'

describe('combineAllocation', () => {
  it('adds approved limit requests to the recorded sales', () => {
    expect(combineAllocation('300.00', '9850')).toEqual({
      sales_usd: '300.00',
      limits_usd: '9850.00',
      total_usd: '10150.00',
    })
  })

  it('keeps the two parts visible, not just their sum', () => {
    const c = combineAllocation(1000, 250)
    expect(c.sales_usd).toBe('1000.00')
    expect(c.limits_usd).toBe('250.00')
  })

  it('treats a missing side as zero — an agency with only sales, or only limits', () => {
    expect(combineAllocation(null, '500').total_usd).toBe('500.00')
    expect(combineAllocation('500', undefined).total_usd).toBe('500.00')
    expect(combineAllocation(null, null).total_usd).toBe('0.00')
  })

  it('is exact where floating point is not', () => {
    // 0.1 + 0.2 in binary floats is 0.30000000000000004.
    expect(combineAllocation('0.10', '0.20').total_usd).toBe('0.30')
  })

  it('accepts the numbers Supabase actually returns for NUMERIC columns', () => {
    expect(combineAllocation(1234.5, 65.5).total_usd).toBe('1300.00')
  })
})

describe('latestOf', () => {
  it('picks the later of two timestamps', () => {
    expect(latestOf('2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z')).toBe('2026-09-20T00:00:00Z')
    expect(latestOf('2026-09-25T00:00:00Z', '2026-09-20T00:00:00Z')).toBe('2026-09-25T00:00:00Z')
  })

  it('falls back to whichever exists, or null', () => {
    expect(latestOf(null, '2026-09-20T00:00:00Z')).toBe('2026-09-20T00:00:00Z')
    expect(latestOf('2026-09-20T00:00:00Z', undefined)).toBe('2026-09-20T00:00:00Z')
    expect(latestOf(null, null)).toBeNull()
  })

  it('compares instants, not strings — different offsets for the same moment', () => {
    // 10:00+06:00 is 04:00Z, earlier than 05:00Z even though "10" > "05".
    expect(latestOf('2026-09-20T10:00:00+06:00', '2026-09-20T05:00:00Z')).toBe('2026-09-20T05:00:00Z')
  })
})

function row(kind: 'SALE' | 'LIMIT', id: string, at: string): AllocationHistoryRow {
  return {
    kind,
    id,
    reference: id,
    at,
    usd_amount: '100.00',
    bdt_amount: kind === 'SALE' ? '12000.00' : null,
    rate: kind === 'SALE' ? '120.0000' : null,
    ad_account: null,
  }
}

describe('mergeAllocationHistory', () => {
  it('interleaves sales and limit approvals newest first', () => {
    const merged = mergeAllocationHistory(
      [row('SALE', 's1', '2026-09-10T00:00:00Z'), row('SALE', 's2', '2026-09-01T00:00:00Z')],
      [row('LIMIT', 'l1', '2026-09-15T00:00:00Z'), row('LIMIT', 'l2', '2026-08-30T00:00:00Z')],
    )
    expect(merged.map((r) => r.id)).toEqual(['l1', 's1', 's2', 'l2'])
  })

  it('does not mutate its inputs', () => {
    const sales = [row('SALE', 's1', '2026-09-10T00:00:00Z')]
    const limits = [row('LIMIT', 'l1', '2026-09-15T00:00:00Z')]
    mergeAllocationHistory(sales, limits)
    expect(sales.map((r) => r.id)).toEqual(['s1'])
    expect(limits.map((r) => r.id)).toEqual(['l1'])
  })

  it('keeps a sale before a limit approval recorded at the same instant', () => {
    const t = '2026-09-10T00:00:00Z'
    const merged = mergeAllocationHistory([row('SALE', 's1', t)], [row('LIMIT', 'l1', t)])
    expect(merged.map((r) => r.id)).toEqual(['s1', 'l1'])
  })

  it('handles either side being empty', () => {
    expect(mergeAllocationHistory([], [])).toEqual([])
    expect(mergeAllocationHistory([], [row('LIMIT', 'l1', '2026-09-10T00:00:00Z')])).toHaveLength(1)
  })

  it('carries no BDT or rate on a limit approval', () => {
    const [l] = mergeAllocationHistory([], [row('LIMIT', 'l1', '2026-09-10T00:00:00Z')])
    expect(l.bdt_amount).toBeNull()
    expect(l.rate).toBeNull()
  })
})

describe('totalTodayApprovals', () => {
  it("adds today's approved limit requests across every agency", () => {
    expect(
      totalTodayApprovals([
        { today_usd_approved: '100.00', today_approval_count: 1 },
        { today_usd_approved: 250.5, today_approval_count: '2' },
      ]),
    ).toEqual({ usd: '350.50', count: 3 })
  })

  it('is zero for a quiet day, an empty list, or missing values', () => {
    expect(totalTodayApprovals([])).toEqual({ usd: '0.00', count: 0 })
    expect(
      totalTodayApprovals([{ today_usd_approved: null, today_approval_count: undefined }]),
    ).toEqual({ usd: '0.00', count: 0 })
    expect(
      totalTodayApprovals([{ today_usd_approved: 0, today_approval_count: 0 }]),
    ).toEqual({ usd: '0.00', count: 0 })
  })

  it('is exact where floating point is not', () => {
    expect(
      totalTodayApprovals([
        { today_usd_approved: '0.10', today_approval_count: 1 },
        { today_usd_approved: '0.20', today_approval_count: 1 },
      ]).usd,
    ).toBe('0.30')
  })
})
