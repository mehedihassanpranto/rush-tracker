import { dec } from '@/lib/money/money'
import type { MoneyInput } from '@/lib/money/money'

/**
 * What the platform has allocated to one agency, in USD: the sales recorded by
 * hand (which carry the BDT received) PLUS the approved limit requests on
 * platform-owned accounts (which carry no BDT — the client pays the agency, and
 * what the agency pays the platform for them is not recorded on the request).
 *
 * Kept as two figures plus their sum on purpose. The two can overlap — an
 * agency that pre-bought dollars AND then had limits approved is counted twice
 * if both are recorded — so the split has to stay visible rather than collapse
 * into one number nobody can audit.
 *
 * Pure and dependency-free so it is unit tested directly.
 */

export interface AllocationTotals {
  /** USD from sales recorded in usd_sales. */
  sales_usd: string
  /** USD from approved limit requests on platform-owned accounts. */
  limits_usd: string
  /** sales_usd + limits_usd. */
  total_usd: string
}

export function combineAllocation(
  salesUsd: MoneyInput | null | undefined,
  limitsUsd: MoneyInput | null | undefined,
): AllocationTotals {
  const s = dec(salesUsd ?? 0)
  const l = dec(limitsUsd ?? 0)
  return {
    sales_usd: s.toFixed(2),
    limits_usd: l.toFixed(2),
    total_usd: s.plus(l).toFixed(2),
  }
}

/** The later of two optional ISO timestamps — an agency's last activity is
 * whichever of its last sale and last limit approval came later. */
export function latestOf(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

export interface AllocationHistoryRow {
  kind: 'SALE' | 'LIMIT'
  id: string
  /** USD-2026-00042 for a sale, LR-000077 for a limit approval. */
  reference: string
  /** sold_at for a sale, approved_at for a limit approval. */
  at: string
  usd_amount: string
  /** null for a limit approval — no BDT is recorded against it. */
  bdt_amount: string | null
  /** null for a limit approval, for the same reason. */
  rate: string | null
  ad_account: { id: string; account_code: string; name: string } | null
}

/** Newest first; a sale and an approval at the same instant keep the sale first
 * so the order is stable. */
export function mergeAllocationHistory(
  sales: Array<AllocationHistoryRow>,
  limits: Array<AllocationHistoryRow>,
): Array<AllocationHistoryRow> {
  return [...sales, ...limits]
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        new Date(b.row.at).getTime() - new Date(a.row.at).getTime() || a.index - b.index,
    )
    .map((x) => x.row)
}

/** One agency's approvals for today's business day, as the view reports them. */
export interface TodayApprovalRow {
  today_usd_approved: MoneyInput | null | undefined
  today_approval_count: number | string | null | undefined
}

/** Today's approved limit requests across every agency: total USD and count.
 * Missing values count as zero, so an agency with a quiet day is harmless. */
export function totalTodayApprovals(rows: Array<TodayApprovalRow>): {
  usd: string
  count: number
} {
  let usd = dec(0)
  let count = 0
  for (const r of rows) {
    usd = usd.plus(dec(r.today_usd_approved ?? 0))
    count += Number(r.today_approval_count ?? 0)
  }
  return { usd: usd.toFixed(2), count }
}
