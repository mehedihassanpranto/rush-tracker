import Decimal from 'decimal.js'
import { dec } from '@/lib/money/money'
import type { MoneyInput } from '@/lib/money/money'
import { BDT_DP, USD_DP } from '@/lib/finance/accounting-policy'

/**
 * Transfer fees for Finance v2 (plan v2 "Fee model"; docs/ACCOUNTING_POLICY.md).
 *
 * Every fee becomes ONE record — total, your share, the counterparty's share —
 * whether a rule matched or it was typed in. Only your share is ever
 * capitalized into a batch's cost (usd-batch.ts does that, not this file).
 *
 * The leak this file exists to stop: a fee silently becoming zero. A route
 * with no matching rule THROWS (`FEE_RULE_MISSING`) instead of returning 0, and
 * a same-bank transfer that really is free comes back as a matched rule with
 * amount 0 — so "free" and "forgot" are always distinguishable.
 *
 * Pure and dependency-free (no server imports) so it is unit tested directly.
 * At posting the caller snapshots the returned ResolvedFee onto the
 * transaction; later edits to a rule never change posted history.
 */

export type FeeCurrency = 'BDT' | 'USD'

/** How money moves. A bank transfer is BANK_INTERNAL when both ends are the
 * same bank and NPSB otherwise — see bankChannel(). */
export type FeeChannel = 'BANK_INTERNAL' | 'NPSB' | 'BINANCE' | 'PAYONEER'

/** Matches any institution. A rule naming the institution beats one using it. */
export const ANY_INSTITUTION = '*'

export interface FeeTier {
  /** Inclusive upper bound of the transferred amount; null = no upper bound. */
  up_to: MoneyInput | null
  amount: MoneyInput
}

export interface FeeRule {
  id: string
  channel: FeeChannel
  from_institution: string
  to_institution: string
  fee_type: 'FIXED' | 'PERCENT' | 'TIERED'
  /** FIXED: the fee. */
  amount?: MoneyInput
  /** PERCENT: percent of the transferred amount (1.5 = 1.5%). */
  percent?: MoneyInput
  /** TIERED: ascending by up_to. */
  tiers?: Array<FeeTier>
  currency: FeeCurrency
  /** Percent of the fee you bear, 0–100. */
  your_share_pct: MoneyInput
  /** YYYY-MM-DD, inclusive both ends; effective_to null = still in force. */
  effective_from: string
  effective_to: string | null
}

export interface FeeRoute {
  channel: FeeChannel
  from_institution: string
  to_institution: string
  /** Event date, YYYY-MM-DD — the rule in force THEN, not today. */
  date: string
  /** What is being transferred, in the fee's currency (for PERCENT/TIERED). */
  transfer_amount: MoneyInput
}

/** One fee as it is stored on a transaction. Amounts are strings at the
 * currency's precision. */
export interface ResolvedFee {
  source: 'RULE' | 'MANUAL'
  /** The matched rule (RULE only). */
  rule_id: string | null
  currency: FeeCurrency
  total: string
  your_share: string
  counterparty_share: string
  /** RULE only: what the rule said, kept beside an override. */
  rule_total: string | null
  /** Required for MANUAL and for any override. */
  reason: string | null
}

export class FinanceRuleError extends Error {
  constructor(
    readonly code:
      | 'FEE_RULE_MISSING'
      | 'FEE_RULE_AMBIGUOUS'
      | 'FEE_INVALID'
      | 'INSUFFICIENT_INVENTORY'
      | 'BACKDATED_PURCHASE'
      | 'BATCH_CONSUMED'
      | 'BATCH_INVALID',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'FinanceRuleError'
  }
}

const dpFor = (currency: FeeCurrency) => (currency === 'BDT' ? BDT_DP : USD_DP)
const round = (v: Decimal, currency: FeeCurrency) =>
  v.toDecimalPlaces(dpFor(currency), Decimal.ROUND_HALF_UP)
const fmt = (v: Decimal, currency: FeeCurrency) => v.toFixed(dpFor(currency))

/** Institution codes are compared case-insensitively and trimmed. */
const norm = (s: string) => s.trim().toUpperCase()

/** Same bank → BANK_INTERNAL, any two different banks → NPSB. */
export function bankChannel(fromBank: string, toBank: string): FeeChannel {
  return norm(fromBank) === norm(toBank) ? 'BANK_INTERNAL' : 'NPSB'
}

function ruleTotal(rule: FeeRule, transfer: Decimal): Decimal {
  switch (rule.fee_type) {
    case 'FIXED':
      return dec(rule.amount ?? 0)
    case 'PERCENT':
      return transfer.mul(dec(rule.percent ?? 0)).div(100)
    case 'TIERED': {
      for (const tier of rule.tiers ?? []) {
        if (tier.up_to == null || transfer.lte(dec(tier.up_to))) return dec(tier.amount)
      }
      throw new FinanceRuleError(
        'FEE_RULE_MISSING',
        `rule ${rule.id} has no tier covering ${transfer.toString()}`,
      )
    }
  }
}

function splitShare(total: Decimal, yourPct: MoneyInput, currency: FeeCurrency) {
  const pct = dec(yourPct)
  if (pct.lt(0) || pct.gt(100)) {
    throw new FinanceRuleError('FEE_INVALID', 'your share must be between 0% and 100%')
  }
  const yours = round(total.mul(pct).div(100), currency)
  return { yours, theirs: total.minus(yours) }
}

/**
 * The rule in force for a route on its date. Most specific wins (a named
 * institution beats `*`); two equally specific matches are a configuration
 * error, refused rather than guessed. No match at all is FEE_RULE_MISSING —
 * posting must stop until someone decides the fee.
 */
export function resolveFeeRule(rules: Array<FeeRule>, route: FeeRoute): ResolvedFee {
  const from = norm(route.from_institution)
  const to = norm(route.to_institution)
  const matches = rules
    .filter(
      (r) =>
        r.channel === route.channel &&
        r.effective_from <= route.date &&
        (r.effective_to == null || route.date <= r.effective_to) &&
        (r.from_institution === ANY_INSTITUTION || norm(r.from_institution) === from) &&
        (r.to_institution === ANY_INSTITUTION || norm(r.to_institution) === to),
    )
    .map((r) => ({
      r,
      specificity:
        (r.from_institution === ANY_INSTITUTION ? 0 : 1) +
        (r.to_institution === ANY_INSTITUTION ? 0 : 1),
    }))
    .sort((a, b) => b.specificity - a.specificity)

  const routeLabel = `${route.channel} ${route.from_institution} → ${route.to_institution} on ${route.date}`
  if (matches.length === 0) {
    throw new FinanceRuleError('FEE_RULE_MISSING', `no fee rule for ${routeLabel}`)
  }
  if (matches.length > 1 && matches[0].specificity === matches[1].specificity) {
    throw new FinanceRuleError(
      'FEE_RULE_AMBIGUOUS',
      `rules ${matches[0].r.id} and ${matches[1].r.id} both match ${routeLabel}`,
    )
  }

  const rule = matches[0].r
  const total = round(ruleTotal(rule, dec(route.transfer_amount)), rule.currency)
  const { yours, theirs } = splitShare(total, rule.your_share_pct, rule.currency)
  return {
    source: 'RULE',
    rule_id: rule.id,
    currency: rule.currency,
    total: fmt(total, rule.currency),
    your_share: fmt(yours, rule.currency),
    counterparty_share: fmt(theirs, rule.currency),
    rule_total: fmt(total, rule.currency),
    reason: null,
  }
}

function requireReason(reason: string | null | undefined): string {
  const r = reason?.trim()
  if (!r) throw new FinanceRuleError('FEE_INVALID', 'a reason is required')
  return r
}

function checkShares(total: Decimal, yours: Decimal, gross: MoneyInput | undefined) {
  if (total.lt(0)) throw new FinanceRuleError('FEE_INVALID', 'total fee cannot be negative')
  if (yours.lt(0) || yours.gt(total)) {
    throw new FinanceRuleError('FEE_INVALID', 'your share must be between 0 and the total fee')
  }
  if (gross != null && total.gt(dec(gross))) {
    throw new FinanceRuleError('FEE_INVALID', 'the fee cannot exceed the amount transferred')
  }
}

/**
 * A fee typed in by hand — Payoneer, or any unusual charge. The supplier's
 * share is total minus yours; the default (yours = 0) is "supplier bears it".
 */
export function manualFee(input: {
  currency: FeeCurrency
  total: MoneyInput
  your_share?: MoneyInput
  reason: string
  /** The amount transferred, same currency — the fee can't exceed it. */
  gross?: MoneyInput
}): ResolvedFee {
  const total = round(dec(input.total), input.currency)
  const yours = round(dec(input.your_share ?? 0), input.currency)
  checkShares(total, yours, input.gross)
  return {
    source: 'MANUAL',
    rule_id: null,
    currency: input.currency,
    total: fmt(total, input.currency),
    your_share: fmt(yours, input.currency),
    counterparty_share: fmt(total.minus(yours), input.currency),
    rule_total: null,
    reason: requireReason(input.reason),
  }
}

/** Replace a rule's figure, with a reason. The rule id and its original total
 * stay on the record beside the override. */
export function overrideFee(
  resolved: ResolvedFee,
  input: { total: MoneyInput; your_share: MoneyInput; reason: string; gross?: MoneyInput },
): ResolvedFee {
  if (resolved.source !== 'RULE') {
    throw new FinanceRuleError('FEE_INVALID', 'only a rule-matched fee can be overridden')
  }
  const total = round(dec(input.total), resolved.currency)
  const yours = round(dec(input.your_share), resolved.currency)
  checkShares(total, yours, input.gross)
  return {
    ...resolved,
    total: fmt(total, resolved.currency),
    your_share: fmt(yours, resolved.currency),
    counterparty_share: fmt(total.minus(yours), resolved.currency),
    reason: requireReason(input.reason),
  }
}

/**
 * The three owner-given rules (plan v2, Assumptions 1–2) in rule form, for
 * seeding the fee_rules table and for tests. DBBL is Dutch-Bangla Bank's code.
 * Payoneer has no rule on purpose: it is entered by hand every time.
 */
export function defaultFeeRules(effectiveFrom: string): Array<FeeRule> {
  return [
    {
      id: 'dbbl-internal',
      channel: 'BANK_INTERNAL',
      from_institution: 'DBBL',
      to_institution: 'DBBL',
      fee_type: 'FIXED',
      amount: 0,
      currency: 'BDT',
      your_share_pct: 100,
      effective_from: effectiveFrom,
      effective_to: null,
    },
    {
      id: 'npsb-flat',
      channel: 'NPSB',
      from_institution: ANY_INSTITUTION,
      to_institution: ANY_INSTITUTION,
      fee_type: 'FIXED',
      amount: 10,
      currency: 'BDT',
      your_share_pct: 100,
      effective_from: effectiveFrom,
      effective_to: null,
    },
    {
      id: 'binance-transfer',
      channel: 'BINANCE',
      from_institution: ANY_INSTITUTION,
      to_institution: ANY_INSTITUTION,
      fee_type: 'FIXED',
      amount: '0.01',
      currency: 'USD',
      your_share_pct: 100,
      effective_from: effectiveFrom,
      effective_to: null,
    },
  ]
}
