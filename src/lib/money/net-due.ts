import { dec } from '@/lib/money/money'

/**
 * Net Receivable (agency/platform) / Amount Payable (client):
 *
 *   net = gross outstanding due − unused ad account balance ("ad credit")
 *
 * Ad credit = Σ max(0, spend_cap − amount_spent) over the client's ACTIVE
 * USD ad accounts — spend the client already paid for that still sits unused
 * in Meta. Display only: the ledger's due (client_financials) stays the only
 * figure anything financial is based on; nothing here is stored.
 */

/** One account's contribution to ad credit, in USD, or null when it can't
 * count: not USD (no FX), no spend cap, or no Meta figures. An overspent
 * account contributes 0, never a negative. */
export function accountAdCreditUsd(a: {
  currency: string | null
  spend_cap: string | number | null
  amount_spent: string | number | null
}): string | null {
  if (a.currency !== 'USD' || a.spend_cap == null) return null
  const remaining = dec(String(a.spend_cap)).minus(dec(String(a.amount_spent ?? 0)))
  return remaining.gt(0) ? remaining.toFixed(2) : '0.00'
}

export interface NetDueFigures {
  /** Ledger due (client_financials.current_due), BDT. */
  grossDueBdt: string
  /** grossDueBdt converted at each client's USD rate. */
  grossDueUsd: string
  /** Unused ad account balance, USD. */
  adCreditUsd: string
  /** adCreditUsd converted at each account's effective rate (adAccountUsdRate). */
  adCreditBdt: string
  /** gross − credit; negative = the client holds more ad credit than it owes. */
  netUsd: string
  netBdt: string
  /** Active linked accounts whose Meta figures couldn't be read — the credit
   * may be understated when > 0. */
  unreadAccounts: number
}

export function netDueFigures(input: {
  grossDueBdt: string
  grossDueUsd: string
  adCreditUsd: string
  adCreditBdt: string
  unreadAccounts?: number
}): NetDueFigures {
  return {
    grossDueBdt: dec(input.grossDueBdt).toFixed(2),
    grossDueUsd: dec(input.grossDueUsd).toFixed(2),
    adCreditUsd: dec(input.adCreditUsd).toFixed(2),
    adCreditBdt: dec(input.adCreditBdt).toFixed(2),
    netUsd: dec(input.grossDueUsd).minus(dec(input.adCreditUsd)).toFixed(2),
    netBdt: dec(input.grossDueBdt).minus(dec(input.adCreditBdt)).toFixed(2),
    unreadAccounts: input.unreadAccounts ?? 0,
  }
}

/** Sums several clients' figures (agency-wide totals). */
export function sumNetDueFigures(all: Array<NetDueFigures>): NetDueFigures {
  const total = (k: keyof Omit<NetDueFigures, 'unreadAccounts'>) =>
    all.reduce((s, f) => s.plus(dec(f[k])), dec(0)).toFixed(2)
  return netDueFigures({
    grossDueBdt: total('grossDueBdt'),
    grossDueUsd: total('grossDueUsd'),
    adCreditUsd: total('adCreditUsd'),
    adCreditBdt: total('adCreditBdt'),
    unreadAccounts: all.reduce((s, f) => s + f.unreadAccounts, 0),
  })
}

/**
 * Client portal framing (owner decision, 2026-10-05): "Amount Payable" never
 * goes below 0 — a surplus is shown separately as a credit balance.
 */
export function clientPayableView(net: string): { payable: string; creditBalance: string | null } {
  const n = dec(net)
  return n.lt(0)
    ? { payable: '0.00', creditBalance: n.neg().toFixed(2) }
    : { payable: n.toFixed(2), creditBalance: null }
}

/**
 * Agency/platform framing (owner decision, 2026-10-05): the real figure, but a
 * negative one is labelled "Net Credit" with a positive amount instead of a
 * minus sign under "Net Receivable".
 */
export function receivableView(net: string): { kind: 'receivable' | 'credit'; amount: string } {
  const n = dec(net)
  return n.lt(0)
    ? { kind: 'credit', amount: n.neg().toFixed(2) }
    : { kind: 'receivable', amount: n.toFixed(2) }
}
