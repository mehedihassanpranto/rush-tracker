import { describe, expect, it } from 'vitest'
import {
  accountAdCreditUsd,
  clientPayableView,
  netDueFigures,
  receivableView,
  sumNetDueFigures,
} from './net-due'

describe('accountAdCreditUsd', () => {
  it('is spend cap minus spent for a USD account, accepting runtime numbers', () => {
    expect(accountAdCreditUsd({ currency: 'USD', spend_cap: 500, amount_spent: '121.75' })).toBe('378.25')
  })
  it('never goes negative for an overspent account', () => {
    expect(accountAdCreditUsd({ currency: 'USD', spend_cap: '100', amount_spent: '130' })).toBe('0.00')
  })
  it("doesn't count non-USD accounts or accounts without a spend cap", () => {
    expect(accountAdCreditUsd({ currency: 'BDT', spend_cap: '100', amount_spent: '0' })).toBeNull()
    expect(accountAdCreditUsd({ currency: 'USD', spend_cap: null, amount_spent: '0' })).toBeNull()
    expect(accountAdCreditUsd({ currency: null, spend_cap: null, amount_spent: null })).toBeNull()
  })
})

describe('netDueFigures', () => {
  it("matches the owner's worked example (DF IT Solutions)", () => {
    const f = netDueFigures({ grossDueBdt: '154162', grossDueUsd: '1263.62', adCreditUsd: '927.94', adCreditBdt: '113208.68' })
    expect(f.netUsd).toBe('335.68')
    expect(f.netBdt).toBe('40953.32')
  })
  it('goes negative when credit exceeds the due', () => {
    expect(netDueFigures({ grossDueBdt: '0', grossDueUsd: '0', adCreditUsd: '50', adCreditBdt: '6100' }).netUsd).toBe('-50.00')
  })
  it('sums clients', () => {
    const a = netDueFigures({ grossDueBdt: '1220', grossDueUsd: '10', adCreditUsd: '4', adCreditBdt: '488', unreadAccounts: 1 })
    const b = netDueFigures({ grossDueBdt: '0', grossDueUsd: '0', adCreditUsd: '6', adCreditBdt: '732' })
    expect(sumNetDueFigures([a, b])).toMatchObject({ grossDueUsd: '10.00', adCreditUsd: '10.00', netUsd: '0.00', netBdt: '0.00', unreadAccounts: 1 })
    expect(sumNetDueFigures([]).netUsd).toBe('0.00')
  })
})

describe('views', () => {
  it('client: payable floors at 0 and shows the surplus as credit', () => {
    expect(clientPayableView('335.68')).toEqual({ payable: '335.68', creditBalance: null })
    expect(clientPayableView('-50')).toEqual({ payable: '0.00', creditBalance: '50.00' })
    expect(clientPayableView('0')).toEqual({ payable: '0.00', creditBalance: null })
  })
  it('agency: a negative net is a Net Credit with a positive amount', () => {
    expect(receivableView('335.68')).toEqual({ kind: 'receivable', amount: '335.68' })
    expect(receivableView('-50')).toEqual({ kind: 'credit', amount: '50.00' })
  })
})
