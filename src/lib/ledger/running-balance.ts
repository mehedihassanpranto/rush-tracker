import { dec } from '@/lib/money/money'
import type { LedgerEntry, LedgerEntryWithBalance } from '@/types/domain'

/**
 * Attach a running balance to ledger entries (spec §35, §66). Input is
 * newest-first (as returned from the DB); the running balance is computed
 * chronologically (oldest-first) with decimal.js so it is never subject to
 * floating-point drift, then mapped back onto the original order.
 *
 * The balance after the newest entry equals the client's current due — the
 * same figure `client_financials()` derives in SQL. Pure and DB-free so it is
 * unit-tested directly (see running-balance.test.ts).
 */
export function withRunningBalance(
  entriesDesc: Array<LedgerEntry>,
): Array<LedgerEntryWithBalance> {
  const asc = [...entriesDesc].reverse()
  let balance = dec(0)
  const balances = new Map<string, string>()
  for (const e of asc) {
    balance = balance.plus(e.debit_bdt).minus(e.credit_bdt)
    balances.set(e.id, balance.toFixed(2))
  }
  return entriesDesc.map((e) => ({
    ...e,
    balance_after: balances.get(e.id) ?? '0',
  }))
}
