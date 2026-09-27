import Decimal from 'decimal.js'
import { dec } from '@/lib/money/money'
import type { MoneyInput } from '@/lib/money/money'

/**
 * Source-wise USD stock for the platform's stock ledger (spec §6.3).
 *
 * Agencies buy from the pooled stock, not from a named source, so a sale never
 * says which source's dollars it used. "How much of source S2 is left?" is
 * therefore a DERIVED figure: walk every purchase oldest-first and spend the
 * total USD sold against them until it runs out (FIFO). That ordering across
 * rows is why this is a function and not a SQL view — depletion does not
 * express cleanly as one query.
 *
 * Pure and dependency-free on purpose (no server imports) so it is unit
 * tested directly, and so the money math has exactly one implementation.
 */

export interface PurchaseLot {
  source_id: string
  usd_amount: MoneyInput
  bdt_amount: MoneyInput
  /** ISO timestamp. FIFO order is by this, then by input position. */
  purchased_at: string
}

export interface SourceRef {
  id: string
  name: string
  payment_method: string | null
  is_active: boolean
}

export interface SourceStockRow {
  source_id: string
  name: string
  payment_method: string | null
  is_active: boolean
  purchased_usd: string
  allocated_usd: string
  remaining_usd: string
  bdt_invested: string
  /** Weighted-average BDT per USD over this source's purchases; null when it
   * has none (a rate over zero dollars is undefined, not zero). */
  avg_buying_rate: string | null
}

export interface SourceWiseStock {
  rows: Array<SourceStockRow>
  /** USD sold beyond everything ever purchased. Non-zero means the ledger has
   * recorded more dollars leaving than arriving — usually a purchase that has
   * not been entered yet. Reported, never hidden. */
  oversold_usd: string
}

export function computeSourceWiseStock(
  sources: Array<SourceRef>,
  purchases: Array<PurchaseLot>,
  totalSoldUsd: MoneyInput,
): SourceWiseStock {
  // Stable oldest-first: Array.prototype.sort is stable, so equal timestamps
  // keep the order they were supplied in (the caller orders by created_at).
  const ordered = purchases
    .map((p, index) => ({ p, index, t: new Date(p.purchased_at).getTime() }))
    .sort((a, b) => a.t - b.t || a.index - b.index)
    .map((x) => x.p)

  const purchased = new Map<string, Decimal>()
  const invested = new Map<string, Decimal>()
  const allocated = new Map<string, Decimal>()

  let toSpend = dec(totalSoldUsd)
  if (toSpend.isNegative()) toSpend = dec(0)

  for (const lot of ordered) {
    const usd = dec(lot.usd_amount)
    const bdt = dec(lot.bdt_amount)
    purchased.set(lot.source_id, (purchased.get(lot.source_id) ?? dec(0)).plus(usd))
    invested.set(lot.source_id, (invested.get(lot.source_id) ?? dec(0)).plus(bdt))

    const take = Decimal.min(usd, toSpend)
    allocated.set(lot.source_id, (allocated.get(lot.source_id) ?? dec(0)).plus(take))
    toSpend = toSpend.minus(take)
  }

  const rows = sources
    .map((s): SourceStockRow => {
      const bought = purchased.get(s.id) ?? dec(0)
      const used = allocated.get(s.id) ?? dec(0)
      const bdt = invested.get(s.id) ?? dec(0)
      return {
        source_id: s.id,
        name: s.name,
        payment_method: s.payment_method,
        is_active: s.is_active,
        purchased_usd: bought.toFixed(2),
        allocated_usd: used.toFixed(2),
        remaining_usd: bought.minus(used).toFixed(2),
        bdt_invested: bdt.toFixed(2),
        avg_buying_rate: bought.isZero() ? null : bdt.div(bought).toFixed(4),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  return { rows, oversold_usd: toSpend.toFixed(2) }
}
