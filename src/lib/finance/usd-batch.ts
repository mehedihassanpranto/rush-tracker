import Decimal from 'decimal.js'
import { dec } from '@/lib/money/money'
import type { MoneyInput } from '@/lib/money/money'
import {
  BDT_DP,
  CAPITALIZE_BORNE_FEES,
  PRICING_BASIS,
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
 *   net USD          = gross USD − every USD fee deducted in transit (its TOTAL,
 *                      whoever bears it — the dollars simply did not arrive)
 *   supplier rate    = BDT principal ÷ net USD   (PRICING_BASIS 'net')
 *                      BDT principal ÷ gross USD (PRICING_BASIS 'gross')
 *   capitalized fees = your share of each BDT fee
 *                    + your share of each USD fee × supplier rate ('net' only;
 *                      under 'gross' those dollars are already in the principal)
 *   total BDT cost   = BDT principal + capitalized fees
 *   effective rate   = total BDT cost ÷ net USD — what FIFO consumes at
 *
 * Deterministic from its inputs: recomputing a batch (edit, retry, reopen)
 * cannot charge a fee twice, because the fee is an input, never a running
 * deduction. The DB stores the result as a snapshot at posting.
 */

export interface BatchInput {
  gross_usd: MoneyInput
  /** BDT paid to the supplier, excluding bank fees. */
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

const bdt = (v: Decimal) => v.toDecimalPlaces(BDT_DP, Decimal.ROUND_HALF_UP)

export function computeBatchCost(input: BatchInput): BatchCost {
  const gross = dec(input.gross_usd)
  const principal = dec(input.bdt_principal)
  if (gross.lte(0)) throw new FinanceRuleError('BATCH_INVALID', 'gross USD must be positive')
  if (principal.lte(0)) {
    throw new FinanceRuleError('BATCH_INVALID', 'BDT principal must be positive')
  }

  const usdFees = input.fees.filter((f) => f.currency === 'USD')
  const bdtFees = input.fees.filter((f) => f.currency === 'BDT')

  const usdDeducted = usdFees.reduce((s, f) => s.plus(dec(f.total)), dec(0))
  const net = gross.minus(usdDeducted)
  if (net.lte(0)) throw new FinanceRuleError('BATCH_INVALID', 'fees exceed the USD received')

  const rate = principal.div(PRICING_BASIS === 'net' ? net : gross)

  let capitalized = dec(0)
  if (CAPITALIZE_BORNE_FEES) {
    for (const f of bdtFees) capitalized = capitalized.plus(dec(f.your_share))
    if (PRICING_BASIS === 'net') {
      for (const f of usdFees) capitalized = capitalized.plus(bdt(dec(f.your_share).mul(rate)))
    }
  }
  const total = principal.plus(capitalized)

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
