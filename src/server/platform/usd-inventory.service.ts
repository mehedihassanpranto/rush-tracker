import { UserError } from '@/lib/errors/user-error'
import {
  FinanceRuleError,
  bankChannel,
  manualFee,
  overrideFee,
  resolveFeeRule,
} from '@/lib/finance/fees'
import { computeBatchCost } from '@/lib/finance/usd-batch'
import { PAID_IN_CASH, bankName } from '@/schemas/usd-inventory'
import type { FeeChannel, FeeRule, ResolvedFee } from '@/lib/finance/fees'
import type { BatchCost } from '@/lib/finance/usd-batch'
import type { UsdPurchaseDraft } from '@/schemas/usd-inventory'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Shared by the purchase preview and the purchase post (usd-inventory.fns.ts),
 * so what the dialog shows is exactly what gets posted. Fees are resolved here
 * from fee_rules + the supplier's receiving bank; post_usd_purchase() then
 * recomputes net USD, rates and capitalized fees from the same snapshot in
 * the database, which is authoritative.
 */

/** A fee as snapshotted on the purchase: the engine's record plus which leg
 * of the purchase it belongs to and a human label. */
export type PurchaseFee = ResolvedFee & { leg: 'BANK' | 'USD'; label: string }

export interface PurchasePreview {
  fees: Array<PurchaseFee>
  /** Legs with no fee decision yet. Posting is refused until this is empty. */
  missing: Array<{ leg: 'BANK' | 'USD'; message: string }>
  /** null while anything is missing. */
  cost: BatchCost | null
}

/** RPC errors raised as `CODE: message` that the user caused and can fix. */
const USER_CODES =
  /^(NOT_FOUND|SOURCE_INACTIVE|INVALID_AMOUNT|INVALID_DATE|INVALID_KIND|FEE_INVALID|BATCH_INVALID|BACKDATED_PURCHASE|INSUFFICIENT_INVENTORY|NOTE_REQUIRED|REASON_REQUIRED|ALREADY_REVERSED|BATCH_CONSUMED|IMMUTABLE|NOT_PREPAID|LOT_IN_USE|PREPAID_LEFT|INVALID_MODE|PERIOD_CLOSED|PERIOD_NOT_OVER|UNPRICED_CHARGES|DUPLICATE|PAYMENT_APPLIED):\s*/

export function inventoryRpcError(message: string): Error {
  return USER_CODES.test(message) ? new UserError(message.replace(USER_CODES, '')) : new Error(message)
}

function dhakaDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function usdChannelFor(paymentMethod: string | null): FeeChannel | null {
  if (paymentMethod === 'Binance') return 'BINANCE'
  if (paymentMethod === 'Payoneer') return 'PAYONEER'
  return null
}

export async function loadFeeRules(admin: SupabaseClient): Promise<Array<FeeRule>> {
  const { data, error } = await admin.from('fee_rules').select('*')
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<FeeRule>
}

function asUserError(err: unknown): never {
  if (err instanceof FinanceRuleError) {
    throw new UserError(err.message.replace(/^[A-Z_]+:\s*/, ''))
  }
  throw err
}

/** Rule fee, or the manual figure (as an override when a rule matched). A
 * missing rule with no manual figure is reported, never treated as zero. */
function legFee(
  rules: Array<FeeRule>,
  leg: 'BANK' | 'USD',
  label: string,
  route: Parameters<typeof resolveFeeRule>[1] | null,
  manual: UsdPurchaseDraft['bank_fee'],
  gross: number | undefined,
  missingMessage: string,
): { fee?: PurchaseFee; missing?: string } {
  let resolved: ResolvedFee | null = null
  if (route) {
    try {
      resolved = resolveFeeRule(rules, route)
    } catch (err) {
      if (!(err instanceof FinanceRuleError) || err.code !== 'FEE_RULE_MISSING') asUserError(err)
    }
  }
  try {
    if (resolved && manual) {
      resolved = overrideFee(resolved, { ...manual, gross })
    } else if (!resolved && manual) {
      resolved = manualFee({ currency: leg === 'BANK' ? 'BDT' : 'USD', ...manual, gross })
    }
  } catch (err) {
    asUserError(err)
  }
  return resolved ? { fee: { ...resolved, leg, label } } : { missing: missingMessage }
}

export async function previewPurchase(
  admin: SupabaseClient,
  draft: UsdPurchaseDraft,
): Promise<PurchasePreview> {
  const { data: source } = await admin
    .from('usd_sources')
    .select('id, name, payment_method, receiving_institution, is_active')
    .eq('id', draft.source_id)
    .maybeSingle()
  if (!source) throw new UserError('Source not found')
  const s = source as {
    name: string
    payment_method: string | null
    receiving_institution: string | null
  }

  const rules = await loadFeeRules(admin)
  const date = dhakaDate(draft.purchased_at)
  const fees: Array<PurchaseFee> = []
  const missing: PurchasePreview['missing'] = []

  // Bank leg: your BDT to the supplier's bank.
  if (draft.paid_from !== PAID_IN_CASH) {
    const to = s.receiving_institution
    const channel = to ? bankChannel(draft.paid_from, to) : null
    const r = legFee(
      rules,
      'BANK',
      to
        ? `Bank: ${bankName(draft.paid_from)} → ${bankName(to)}${channel === 'NPSB' ? ' (NPSB)' : ''}`
        : `Bank: ${bankName(draft.paid_from)} → supplier`,
      to && channel
        ? {
            channel,
            from_institution: draft.paid_from,
            to_institution: to,
            date,
            transfer_amount: draft.bdt_principal,
          }
        : null,
      draft.bank_fee,
      undefined,
      to
        ? `No fee rule covers ${bankName(draft.paid_from)} → ${bankName(to)}. Enter the bank fee by hand, or add a rule.`
        : `${s.name} has no receiving bank set. Set it under Source Summary → Edit, or enter the bank fee by hand.`,
    )
    if (r.fee) fees.push(r.fee)
    if (r.missing) missing.push({ leg: 'BANK', message: r.missing })
  }

  // USD leg: the supplier's dollars reaching your wallet.
  const usdChannel = usdChannelFor(s.payment_method)
  const method = s.payment_method ?? 'this source'
  const r = legFee(
    rules,
    'USD',
    `${s.payment_method ?? 'USD'} transfer`,
    usdChannel
      ? {
          channel: usdChannel,
          from_institution: s.payment_method ?? '',
          to_institution: s.payment_method ?? '',
          date,
          transfer_amount: draft.gross_usd,
        }
      : null,
    draft.usd_fee,
    draft.gross_usd,
    usdChannel === 'PAYONEER'
      ? 'Enter the Payoneer fee from the statement. Your share is 0 if the supplier bore all of it.'
      : `No fee rule for ${method}. Enter its fee by hand (0 if there was none).`,
  )
  if (r.fee) fees.push(r.fee)
  if (r.missing) missing.push({ leg: 'USD', message: r.missing })

  let cost: BatchCost | null = null
  if (missing.length === 0) {
    try {
      cost = computeBatchCost({ gross_usd: draft.gross_usd, bdt_principal: draft.bdt_principal, fees })
    } catch (err) {
      asUserError(err)
    }
  }
  return { fees, missing, cost }
}
