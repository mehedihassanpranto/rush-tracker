import { describe, expect, it } from 'vitest'
import { withRunningBalance } from './running-balance'
import type { LedgerEntry } from '@/types/domain'

function entry(over: Partial<LedgerEntry> & { id: string }): LedgerEntry {
  return {
    transaction_number: `TXN-${over.id}`,
    client_id: 'c1',
    type: 'LIMIT_APPROVAL',
    reference_type: null,
    reference_id: null,
    usd_amount: null,
    usd_rate: null,
    bdt_amount: null,
    debit_bdt: '0',
    credit_bdt: '0',
    description: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

// Input is newest-first (as the DB returns it).
describe('withRunningBalance (spec §35 due, §66 statement)', () => {
  it('computes the running balance chronologically', () => {
    const rows = [
      entry({ id: '3', credit_bdt: '4000', created_at: '2026-01-03T00:00:00Z' }),
      entry({ id: '2', debit_bdt: '6000', created_at: '2026-01-02T00:00:00Z' }),
      entry({ id: '1', debit_bdt: '12000', created_at: '2026-01-01T00:00:00Z' }),
    ]
    const result = withRunningBalance(rows)
    const byId = Object.fromEntries(result.map((r) => [r.id, r.balance_after]))
    // oldest first: +12000 -> +6000 (=18000) -> -4000 (=14000)
    expect(byId['1']).toBe('12000.00')
    expect(byId['2']).toBe('18000.00')
    expect(byId['3']).toBe('14000.00')
  })

  it('final balance equals current due = sum(debit) - sum(credit)', () => {
    const rows = [
      entry({ id: '2', credit_bdt: '5000' }),
      entry({ id: '1', debit_bdt: '12345.67' }),
    ]
    const result = withRunningBalance(rows)
    // result[0] is the newest row → its balance_after is the current due.
    expect(result[0].balance_after).toBe('7345.67')
  })

  it('preserves the newest-first order of the input', () => {
    const rows = [entry({ id: 'b' }), entry({ id: 'a' })]
    expect(withRunningBalance(rows).map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('handles an empty ledger', () => {
    expect(withRunningBalance([])).toEqual([])
  })

  it('stays decimal-exact across many fractional entries', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      entry({ id: String(i), debit_bdt: '0.1' }),
    )
    // 10 * 0.1 = 1.00 exactly (no float drift to 0.9999999)
    expect(withRunningBalance(rows)[0].balance_after).toBe('1.00')
  })
})
