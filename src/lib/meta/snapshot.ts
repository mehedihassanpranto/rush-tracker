import { dec } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD, META_DUE_THRESHOLD } from '@/lib/meta/thresholds'

/** The meta_* snapshot columns an ad account row carries (meta-snapshot.server.ts).
 * Numerics may arrive as JS numbers at runtime, hence the widened types. */
export interface MetaSnapshotFields {
  meta_amount_spent: string | number | null
  meta_spend_cap: string | number | null
  meta_balance: string | number | null
  meta_currency: string | null
  meta_refreshed_at: string | null
}

export interface MetaSnapshotView {
  currency: string
  spendCap: string | null
  /** spend_cap − amount_spent; null when Meta has no spend cap set. */
  remaining: string | null
  metaDue: string | null
  /** USD-only alerts — the thresholds are flat USD numbers, no FX. */
  low: boolean
  metaDueHigh: boolean
}

const str = (v: string | number | null): string | null => (v == null ? null : String(v))

/** Display figures for one account, or null if it was never refreshed. */
export function metaSnapshotView(a: MetaSnapshotFields): MetaSnapshotView | null {
  if (!a.meta_refreshed_at) return null
  const isUsd = a.meta_currency === 'USD'
  const spendCap = str(a.meta_spend_cap)
  const metaDue = str(a.meta_balance)
  const remaining =
    spendCap != null ? dec(spendCap).minus(dec(str(a.meta_amount_spent) ?? 0)) : null
  return {
    currency: a.meta_currency ?? '',
    spendCap,
    remaining: remaining ? remaining.toFixed(2) : null,
    metaDue,
    low: isUsd && remaining ? remaining.lte(LOW_BALANCE_THRESHOLD) : false,
    metaDueHigh: isUsd && metaDue != null && dec(metaDue).gte(META_DUE_THRESHOLD),
  }
}

/** Most recent refresh across the rows (ISO string), or null if none ever. */
export function latestMetaRefresh(rows: Array<{ meta_refreshed_at: string | null }>): string | null {
  let latest: string | null = null
  for (const r of rows) {
    if (r.meta_refreshed_at && (!latest || r.meta_refreshed_at > latest)) latest = r.meta_refreshed_at
  }
  return latest
}

/** True when the linked rows' snapshot is missing or older than maxAgeMs —
 * the lists refresh themselves once on open in that case. */
export function isMetaSnapshotStale(
  rows: Array<{ external_account_id: string | null; meta_refreshed_at: string | null }>,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  const linked = rows.filter((r) => r.external_account_id)
  if (linked.length === 0) return false
  const latest = latestMetaRefresh(linked)
  return !latest || now - new Date(latest).getTime() > maxAgeMs
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function formatRefreshedAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never'
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
