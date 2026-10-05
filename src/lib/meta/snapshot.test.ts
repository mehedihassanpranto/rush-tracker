import { describe, expect, it } from 'vitest'
import {
  formatRefreshedAgo,
  isMetaSnapshotStale,
  latestMetaRefresh,
  metaSnapshotView,
} from './snapshot'

const base = {
  meta_amount_spent: null,
  meta_spend_cap: null,
  meta_balance: null,
  meta_currency: 'USD',
  meta_refreshed_at: '2026-10-05T03:00:00Z',
}

describe('metaSnapshotView', () => {
  it('is null for an account never refreshed', () => {
    expect(metaSnapshotView({ ...base, meta_refreshed_at: null })).toBeNull()
  })

  it('derives Remaining from spend cap minus spent, accepting runtime numbers', () => {
    const v = metaSnapshotView({ ...base, meta_spend_cap: 500, meta_amount_spent: '121.75', meta_balance: 12.5 })
    expect(v).toMatchObject({ spendCap: '500', remaining: '378.25', metaDue: '12.5', low: false, metaDueHigh: false })
  })

  it('has no Remaining without a spend cap', () => {
    expect(metaSnapshotView({ ...base, meta_amount_spent: '10' })?.remaining).toBeNull()
  })

  it('flags low Remaining and high Meta Due for USD only', () => {
    const usd = metaSnapshotView({ ...base, meta_spend_cap: '100', meta_amount_spent: '40', meta_balance: '100' })
    expect(usd).toMatchObject({ low: true, metaDueHigh: true })
    const bdt = metaSnapshotView({ ...base, meta_currency: 'BDT', meta_spend_cap: '100', meta_amount_spent: '40', meta_balance: '100' })
    expect(bdt).toMatchObject({ low: false, metaDueHigh: false })
  })
})

describe('snapshot age', () => {
  const now = new Date('2026-10-05T03:30:00Z').getTime()
  const rows = [
    { external_account_id: 'act_1', meta_refreshed_at: '2026-10-05T03:00:00Z' },
    { external_account_id: 'act_2', meta_refreshed_at: '2026-10-05T03:25:00Z' },
    { external_account_id: null, meta_refreshed_at: null },
  ]

  it('finds the latest refresh', () => {
    expect(latestMetaRefresh(rows)).toBe('2026-10-05T03:25:00Z')
    expect(latestMetaRefresh([{ meta_refreshed_at: null }])).toBeNull()
  })

  it('is stale when never refreshed or older than the limit, never without linked rows', () => {
    expect(isMetaSnapshotStale(rows, 10 * 60_000, now)).toBe(false)
    expect(isMetaSnapshotStale(rows, 4 * 60_000, now)).toBe(true)
    expect(isMetaSnapshotStale([{ external_account_id: 'act_1', meta_refreshed_at: null }], 60_000, now)).toBe(true)
    expect(isMetaSnapshotStale([{ external_account_id: null, meta_refreshed_at: null }], 60_000, now)).toBe(false)
  })

  it('formats the age', () => {
    expect(formatRefreshedAgo(null, now)).toBe('never')
    expect(formatRefreshedAgo('2026-10-05T03:29:40Z', now)).toBe('just now')
    expect(formatRefreshedAgo('2026-10-05T03:25:00Z', now)).toBe('5 min ago')
    expect(formatRefreshedAgo('2026-10-05T00:30:00Z', now)).toBe('3 h ago')
  })
})
