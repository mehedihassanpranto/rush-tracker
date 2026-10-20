import Decimal from 'decimal.js'
import { dec } from '@/lib/money/money'
import type { MoneyInput } from '@/lib/money/money'
import {
  BDT_DP,
  RATE_DP,
  SUPPLIER_RATE_WARN_MAX,
  SUPPLIER_RATE_WARN_MIN,
  USD_DP,
} from '@/lib/finance/accounting-policy'
import { FinanceRuleError } from '@/lib/finance/fees'
import type { ResolvedFee } from '@/lib/finance/fees'

/**
 * One USD purchase → one FIFO batch with its own acquisition cost (plan v2
 * "Inventory and FIFO"; docs/ACCOUNTING_POLICY.md §2).
 *
 *   net USD        = gross USD − every USD fee deducted in transit (its TOTAL,
 *                    whoever bears it — those dollars simply did not arrive)
 *   capitalized    = your share of each BDT fee (the bank fee)
 *   total BDT cost = BDT principal + capitalized — exactly the taka that left
 *                    your accounts, so the journal entry balances
 *   effective rate = total BDT cost ÷ net USD — what FIFO consumes at
 *   supplier rate  = BDT principal ÷ (net USD + your share of the USD fees):
 *                    the price per dollar you paid for. With the supplier
 *                    pricing on net (Assumption 4), that is their quoted rate.
 *
 * A USD fee is NEVER added to cost as fee × rate. You didn't pay taka for it:
 * its cost is already inside the effective rate, because the principal paid
 * for dollars that never landed. Adding it again was a bug in the first
 * version (2026-10-20) — the purchase's journal entry could not balance.
 *
 * Deterministic from its inputs, so recomputing (edit, retry, reopen) never
 * charges a fee twice. The DB stores the result as a snapshot at posting.
 */

export interface BatchInput {
  gross_usd: MoneyInput
  /** BDT actually paid to the supplier, excluding the bank fee. */
  bdt_principal: MoneyInput
  /** Every fee on this purchase, BDT leg (bank) and USD leg (Binance, Payoneer). */
  fees: Array<ResolvedFee>
}

export interface BatchCost {
  gross_usd: string
  net_usd: string
  bdt_principal: string
  supplier_rate: string
  /** Supplier rate outside SUPPLIER_RATE_WARN_MIN..MAX — warn, never block. */
  rate_warning: boolean
  capitalized_fees_bdt: string
  total_bdt_cost: string
  effective_rate: string
}

export function computeBatchCost(input: BatchInput): BatchCost {
  const gross = dec(input.gross_usd)
  const principal = dec(input.bdt_principal)
  if (gross.lte(0)) throw new FinanceRuleError('BATCH_INVALID', 'gross USD must be positive')
  if (principal.lte(0)) {
    throw new FinanceRuleError('BATCH_INVALID', 'BDT principal must be positive')
  }

  let usdDeducted = dec(0)
  let usdYours = dec(0)
  let capitalized = dec(0)
  for (const f of input.fees) {
    if (f.currency === 'USD') {
      usdDeducted = usdDeducted.plus(dec(f.total))
      usdYours = usdYours.plus(dec(f.your_share))
    } else {
      capitalized = capitalized.plus(dec(f.your_share))
    }
  }
  const net = gross.minus(usdDeducted)
  if (net.lte(0)) throw new FinanceRuleError('BATCH_INVALID', 'fees exceed the USD received')

  const rate = principal.div(net.plus(usdYours))
  const total = principal.plus(capitalized).toDecimalPlaces(BDT_DP, Decimal.ROUND_HALF_UP)

  return {
    gross_usd: gross.toFixed(USD_DP),
    net_usd: net.toFixed(USD_DP),
    bdt_principal: principal.toFixed(BDT_DP),
    supplier_rate: rate.toFixed(RATE_DP),
    rate_warning: rate.lt(SUPPLIER_RATE_WARN_MIN) || rate.gt(SUPPLIER_RATE_WARN_MAX),
    capitalized_fees_bdt: capitalized.toFixed(BDT_DP),
    total_bdt_cost: total.toFixed(BDT_DP),
    effective_rate: total.div(net).toFixed(RATE_DP),
  }
}
