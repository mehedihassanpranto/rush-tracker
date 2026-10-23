import { describe, expect, it } from 'vitest'
import { daysBetween, dhakaDate, periodRange, spendCacheRange } from './periods'
import { dailySpendFromInsights } from '@/lib/meta/insights'

// 2026-10-23 is a Friday. 20:30 UTC on the 22nd is already 02:30 on the 23rd
// in Dhaka (UTC+6).
const FRI = new Date('2026-10-22T20:30:00Z')

describe('dashboard periods (Asia/Dhaka, weeks from Sunday)', () => {
  it('uses the Dhaka calendar day, not UTC', () => {
    expect(dhakaDate(FRI)).toBe('2026-10-23')
    expect(periodRange('today', FRI)).toEqual({ from: '2026-10-23', to: '2026-10-23' })
  })

  it('this week starts on the Sunday before (or on) today', () => {
    expect(periodRange('week', FRI)).toEqual({ from: '2026-10-18', to: '2026-10-23' })
    const sunday = new Date('2026-10-25T06:00:00Z')
    expect(periodRange('week', sunday)).toEqual({ from: '2026-10-25', to: '2026-10-25' })
    const saturday = new Date('2026-10-24T06:00:00Z')
    expect(periodRange('week', saturday)).toEqual({ from: '2026-10-18', to: '2026-10-24' })
  })

  it('this month runs from the 1st to today; last month is the whole previous month', () => {
    expect(periodRange('month', FRI)).toEqual({ from: '2026-10-01', to: '2026-10-23' })
    expect(periodRange('last_month', FRI)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('last month crosses the year and knows February', () => {
    const jan = new Date('2027-01-15T06:00:00Z')
    expect(periodRange('last_month', jan)).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    const mar = new Date('2028-03-02T06:00:00Z') // 2028 is a leap year
    expect(periodRange('last_month', mar)).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('a week can start in the previous month', () => {
    const tue = new Date('2026-12-01T06:00:00Z')
    expect(periodRange('week', tue)).toEqual({ from: '2026-11-29', to: '2026-12-01' })
  })

  it('lists every day inclusive, and caches from the start of last month', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    expect(spendCacheRange(FRI)).toEqual({ from: '2026-09-01', to: '2026-10-23' })
  })
})

describe('dailySpendFromInsights', () => {
  it('fills days Meta left out with 0 and ignores rows outside the range', () => {
    const out = dailySpendFromInsights(
      [
        { spend: '12.345', account_currency: 'USD', date_start: '2026-10-21', date_stop: '2026-10-21' },
        { spend: '3', account_currency: 'USD', date_start: '2026-10-23', date_stop: '2026-10-23' },
        { spend: '99', account_currency: 'USD', date_start: '2026-10-25', date_stop: '2026-10-25' },
      ],
      '2026-10-21',
      '2026-10-23',
      null,
    )
    expect(out).toEqual([
      { date: '2026-10-21', spend: '12.35', currency: 'USD' },
      { date: '2026-10-22', spend: '0.00', currency: 'USD' },
      { date: '2026-10-23', spend: '3.00', currency: 'USD' },
    ])
  })

  it('an account with no spend at all still gets zero rows, in its known currency', () => {
    expect(dailySpendFromInsights([], '2026-10-22', '2026-10-23', 'USD')).toEqual([
      { date: '2026-10-22', spend: '0.00', currency: 'USD' },
      { date: '2026-10-23', spend: '0.00', currency: 'USD' },
    ])
  })
})
