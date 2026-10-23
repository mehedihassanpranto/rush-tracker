import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { credentialScopeKey, metaCredentialScopeFor } from '@/lib/meta/credential-scope'
import { dailySpendFromInsights } from '@/lib/meta/insights'
import { fetchMetaDailySpend } from '@/server/meta/meta.server'
import type { MetaCredentialScope } from '@/lib/meta/credential-scope'

/**
 * Fill meta_daily_spend (migration 000067) from Meta's Insights for some ad
 * accounts over [from, to]: one row per account per day, 0 for a day with no
 * spend, so the dashboard can tell "no spend" from "not fetched". Grouped per
 * credential set (the platform's for pool accounts, the owning agency's
 * otherwise); a set that isn't configured, or an account Meta won't return,
 * counts as failed and keeps its previous rows. Display data only.
 *
 * Shared by the nightly meta-sync cron and the dashboard's Refresh button.
 */
export interface SpendAccountRow {
  id: string
  external_account_id: string
  is_platform: boolean
  organization_id: string | null
  meta_currency: string | null
}

export async function refreshDailySpend(
  rows: Array<SpendAccountRow>,
  from: string,
  to: string,
): Promise<{ refreshed: number; failed: number }> {
  const admin = getSupabaseAdminClient()
  const groups = new Map<string, { scope: MetaCredentialScope; rows: Array<SpendAccountRow> }>()
  for (const row of rows) {
    const scope = metaCredentialScopeFor(row)
    const key = credentialScopeKey(scope)
    const g = groups.get(key) ?? { scope, rows: [] }
    g.rows.push(row)
    groups.set(key, g)
  }

  let refreshed = 0
  const fetchedAt = new Date().toISOString()
  for (const { scope, rows: groupRows } of groups.values()) {
    let live: Array<Array<{ spend?: string; account_currency?: string; date_start?: string }> | null>
    try {
      live = await fetchMetaDailySpend(groupRows.map((r) => r.external_account_id), from, to, scope)
    } catch {
      continue // credentials not configured — every account in the set fails
    }
    const upserts = groupRows.flatMap((row, i) => {
      const data = live[i]
      if (!data) return []
      refreshed++
      return dailySpendFromInsights(data, from, to, row.meta_currency).map((d) => ({
        ad_account_id: row.id,
        spend_date: d.date,
        spend: d.spend,
        currency: d.currency,
        fetched_at: fetchedAt,
      }))
    })
    for (let i = 0; i < upserts.length; i += 1000) {
      const { error } = await admin.from('meta_daily_spend').upsert(upserts.slice(i, i + 1000))
      if (error) throw new Error(error.message)
    }
  }
  return { refreshed, failed: rows.length - refreshed }
}

/** Every ad account Meta can be asked about, for the nightly refresh. */
export async function allSpendAccounts(): Promise<Array<SpendAccountRow>> {
  const { data, error } = await getSupabaseAdminClient()
    .from('ad_accounts')
    .select('id, external_account_id, is_platform, organization_id, meta_currency')
    .not('external_account_id', 'is', null)
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<SpendAccountRow>
}
