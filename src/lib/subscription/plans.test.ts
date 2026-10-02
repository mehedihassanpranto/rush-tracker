import { describe, expect, it } from 'vitest'
import {
  addMonths,
  billingStatus,
  checkPlanLimit,
  dhakaToday,
  nextPeriod,
  paidThroughFrom,
  planLimit,
  planLimitMessage,
} from './plans'

describe('checkPlanLimit', () => {
  it('treats a null limit as unlimited', () => {
    expect(checkPlanLimit(10_000, 50, null)).toEqual({ ok: true })
  })
  it('allows reaching the limit exactly', () => {
    expect(checkPlanLimit(4, 1, 5)).toEqual({ ok: true })
  })
  it('refuses going over the limit', () => {
    expect(checkPlanLimit(5, 1, 5)).toEqual({ ok: false, used: 5, limit: 5 })
  })
  it('counts a bulk add as a whole', () => {
    expect(checkPlanLimit(10, 6, 15)).toEqual({ ok: false, used: 10, limit: 15 })
    expect(checkPlanLimit(10, 5, 15)).toEqual({ ok: true })
  })
  it('refuses any add when already over (after a downgrade)', () => {
    expect(checkPlanLimit(30, 1, 20).ok).toBe(false)
  })
  it('a zero limit allows nothing', () => {
    expect(checkPlanLimit(0, 1, 0).ok).toBe(false)
  })
})

describe('planLimit', () => {
  const plan = { max_clients: 5, max_ad_accounts: 15, max_staff: null }
  it('reads each limit', () => {
    expect(planLimit(plan, 'clients')).toBe(5)
    expect(planLimit(plan, 'adAccounts')).toBe(15)
    expect(planLimit(plan, 'staff')).toBeNull()
  })
  it('no plan means no limit', () => {
    expect(planLimit(null, 'clients')).toBeNull()
  })
})

describe('planLimitMessage', () => {
  it('names the plan, the limit and the usage', () => {
    expect(planLimitMessage('clients', 'Basic', 5, 5)).toContain('Basic plan allows 5 active clients')
    expect(planLimitMessage('adAccounts', 'Basic', 12, 15, 4)).toContain('4 more ad accounts')
    expect(planLimitMessage('staff', 'Basic', 1, 1)).toContain('allows 1 active staff login ')
  })
})

describe('billingStatus', () => {
  const today = '2026-10-02'
  it('exempt wins over everything', () => {
    expect(billingStatus({ billingExempt: true, planFeeBdt: '15000', paidThrough: null, today })).toBe('exempt')
  })
  it('no plan or a free plan', () => {
    expect(billingStatus({ billingExempt: false, planFeeBdt: null, paidThrough: null, today })).toBe('no_plan')
    expect(billingStatus({ billingExempt: false, planFeeBdt: '0', paidThrough: null, today })).toBe('no_plan')
  })
  it('paid plan never paid', () => {
    expect(billingStatus({ billingExempt: false, planFeeBdt: 1500, paidThrough: null, today })).toBe('unpaid')
  })
  it('paid through today is still paid; yesterday is overdue', () => {
    expect(billingStatus({ billingExempt: false, planFeeBdt: 1500, paidThrough: today, today })).toBe('paid')
    expect(billingStatus({ billingExempt: false, planFeeBdt: 1500, paidThrough: '2026-10-01', today })).toBe('overdue')
  })
})

describe('periods', () => {
  it('paidThroughFrom picks the latest end', () => {
    expect(paidThroughFrom([])).toBeNull()
    expect(paidThroughFrom([{ period_end: '2026-09-30' }, { period_end: '2026-11-04' }, { period_end: '2026-10-15' }])).toBe('2026-11-04')
  })
  it('addMonths clamps to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
  })
  it('nextPeriod continues an active subscription', () => {
    expect(nextPeriod('2026-10-31', '2026-10-02')).toEqual({ start: '2026-11-01', end: '2026-11-30' })
  })
  it('nextPeriod starts today when never paid or lapsed', () => {
    expect(nextPeriod(null, '2026-10-05')).toEqual({ start: '2026-10-05', end: '2026-11-04' })
    expect(nextPeriod('2026-08-31', '2026-10-05')).toEqual({ start: '2026-10-05', end: '2026-11-04' })
  })
  it('dhakaToday is UTC+6', () => {
    expect(dhakaToday(new Date('2026-10-01T19:30:00Z'))).toBe('2026-10-02')
    expect(dhakaToday(new Date('2026-10-01T17:30:00Z'))).toBe('2026-10-01')
  })
})
