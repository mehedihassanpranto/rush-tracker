import Decimal from 'decimal.js'
import { dec } from '@/lib/money/money'
import type { MoneyInput } from '@/lib/money/money'
import { BDT_DP, RATE_DP, USD_DP } from '@/lib/finance/accounting-policy'
import { FinanceRuleError } from '@/lib/finance/fees'

/**
 * FIFO consumption of USD lots (plan v2 "Inventory and FIFO"; docs/
 * ACCOUNTING_POLICY.md §2–3). One allocator for both places FIFO applies:
 * the shared USD inventory (usd batches) and each prepaid Meta account's own
 * funded lots.
 *
 * ROUNDING: a lot carries what is LEFT of it in both USD and BDT. A partial
 * take costs round(take × bdt_left ÷ usd_left, 2); the take that empties the
 * lot costs exactly its bdt_left. So every lot's allocations sum to its cost
 * to the paisa, and opening + movements = closing with no residue — the
 * remainder lands on the last allocation of each lot.
 *
 * Pure: takes lots in, returns allocations and the lots after, mutates
 * nothing. In the database the same walk runs inside the posting RPC, with
 * the lots row-locked in this same order.
 */

export interface Lot {
  id: string
  /** Posting order. FIFO is by this, then id — never by event or created time. */
  seq: number
  usd_left: MoneyInput
  bdt_left: MoneyInput
}

export interface Allocation {
  lot_id: string
  usd: string
  /** bdt_left ÷ usd_left of the lot at the time of the take. */
  unit_cost: string
  bdt: string
}

export interface FifoResult {
  allocations: Array<Allocation>
  usd: string
  bdt: string
  /** Every input lot after the take, same order as consumed. */
  lots: Array<{ id: string; seq: number; usd_left: string; bdt_left: string }>
}

export function fifoOrder<T extends { seq: number; id: string }>(lots: Array<T>): Array<T> {
  return [...lots].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Consume `usdQty` oldest-first. Refuses (never goes negative) when the lots
 * hold less than asked. */
export function allocateFifo(lots: Array<Lot>, usdQty: MoneyInput): FifoResult {
  const qty = dec(usdQty).toDecimalPlaces(USD_DP, Decimal.ROUND_HALF_UP)
  if (qty.lte(0)) throw new FinanceRuleError('BATCH_INVALID', 'quantity must be positive')

  const ordered = fifoOrder(lots)
  const available = ordered.reduce((s, l) => s.plus(dec(l.usd_left)), dec(0))
  if (available.lt(qty)) {
    throw new FinanceRuleError(
      'INSUFFICIENT_INVENTORY',
      `needs ${qty.toFixed(2)} USD, only ${available.toFixed(2)} available`,
    )
  }

  const allocations: Array<Allocation> = []
  let need = qty
  let totalBdt = dec(0)
  const after = ordered.map((l) => {
    const usdLeft = dec(l.usd_left)
    const bdtLeft = dec(l.bdt_left)
    if (need.isZero() || usdLeft.isZero()) {
      return { id: l.id, seq: l.seq, usd_left: usdLeft.toFixed(USD_DP), bdt_left: bdtLeft.toFixed(BDT_DP) }
    }
    const take = Decimal.min(usdLeft, need)
    const cost = take.eq(usdLeft)
      ? bdtLeft
      : take.mul(bdtLeft).div(usdLeft).toDecimalPlaces(BDT_DP, Decimal.ROUND_HALF_UP)
    allocations.push({
      lot_id: l.id,
      usd: take.toFixed(USD_DP),
      unit_cost: bdtLeft.div(usdLeft).toFixed(RATE_DP),
      bdt: cost.toFixed(BDT_DP),
    })
    need = need.minus(take)
    totalBdt = totalBdt.plus(cost)
    return {
      id: l.id,
      seq: l.seq,
      usd_left: usdLeft.minus(take).toFixed(USD_DP),
      bdt_left: bdtLeft.minus(cost).toFixed(BDT_DP),
    }
  })

  return { allocations, usd: qty.toFixed(USD_DP), bdt: totalBdt.toFixed(BDT_DP), lots: after }
}

/**
 * Actual spend on a PREPAID Meta account against that account's own funded
 * lots. Spend beyond what is funded is not allowed to drive the asset
 * negative: the funded part is consumed and the rest comes back as
 * `unfunded_usd`, an exception for review (policy §3).
 */
export function consumePrepaidSpend(
  lots: Array<Lot>,
  spendUsd: MoneyInput,
): FifoResult & { unfunded_usd: string } {
  const spend = dec(spendUsd)
  const funded = lots.reduce((s, l) => s.plus(dec(l.usd_left)), dec(0))
  const covered = Decimal.min(spend, funded)
  const unfunded = spend.minus(covered).toFixed(USD_DP)
  if (covered.lte(0)) {
    return {
      allocations: [],
      usd: dec(0).toFixed(USD_DP),
      bdt: dec(0).toFixed(BDT_DP),
      lots: fifoOrder(lots).map((l) => ({
        id: l.id,
        seq: l.seq,
        usd_left: dec(l.usd_left).toFixed(USD_DP),
        bdt_left: dec(l.bdt_left).toFixed(BDT_DP),
      })),
      unfunded_usd: unfunded,
    }
  }
  return { ...allocateFifo(lots, covered), unfunded_usd: unfunded }
}

/**
 * Backdating guard (Assumption 8). A new purchase dated before any batch that
 * has already been consumed would, under FIFO-by-posting-order, change what
 * earlier outgoing USD "should" have cost. Refused instead.
 */
export function assertPurchaseNotBackdated(
  eventDate: string,
  batches: Array<{ id: string; event_date: string; consumed: boolean }>,
): void {
  const later = batches.find((b) => b.consumed && b.event_date > eventDate)
  if (later) {
    throw new FinanceRuleError(
      'BACKDATED_PURCHASE',
      `dated ${eventDate}, before batch ${later.id} (${later.event_date}) which is already in use`,
    )
  }
}

/** A purchase can be reversed only while none of its USD has left. */
export function assertBatchReversible(batch: {
  id: string
  net_usd: MoneyInput
  usd_left: MoneyInput
}): void {
  if (!dec(batch.usd_left).eq(dec(batch.net_usd))) {
    throw new FinanceRuleError(
      'BATCH_CONSUMED',
      `batch ${batch.id} is partly used; reverse its allocations first`,
    )
  }
}
