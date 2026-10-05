import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { credentialScopeKey, metaCredentialScopeFor } from '@/lib/meta/credential-scope'
import type { MetaCredentialScope } from '@/lib/meta/credential-scope'
import { fetchMetaAdAccounts } from '@/server/meta/meta.server'
import type { MetaAdAccountSummary } from '@/server/meta/meta.server'
import { syncAdAccountName } from '@/server/meta/meta-sync.server'

export interface SnapshotRow {
  id: string
  name: string
  external_account_id: string
  is_platform: boolean
  organization_id: string | null
}

export interface SnapshotResult {
  /** Live summary per ad_accounts.id; accounts Meta didn't return are absent. */
  byId: Map<string, MetaAdAccountSummary>
  refreshed: number
  failed: number
  renamed: number
}

/**
 * Reads each account directly from Meta (never the stale portfolio listing),
 * saves the figures to its meta_* snapshot columns, and — when `rename` is
 * given — applies a name changed in Meta, audited in the org it returns.
 *
 * Callers authorize the rows first; updates match on id alone. One Meta read
 * per account, grouped per credential set (platform for pool accounts, the
 * owning agency's otherwise). A set that isn't configured or an account Meta
 * fails to return counts as `failed` and keeps its previous snapshot.
 */
export async function refreshMetaSnapshots(
  rows: Array<SnapshotRow>,
  rename?: { actorUserId: string; auditOrganizationId: (row: SnapshotRow) => Promise<string> },
): Promise<SnapshotResult> {
  const admin = getSupabaseAdminClient()
  const groups = new Map<string, { scope: MetaCredentialScope; rows: Array<SnapshotRow> }>()
  for (const row of rows) {
    const scope = metaCredentialScopeFor(row)
    const key = credentialScopeKey(scope)
    const group = groups.get(key) ?? { scope, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }

  const byId = new Map<string, MetaAdAccountSummary>()
  for (const { scope, rows: groupRows } of groups.values()) {
    let live: Array<MetaAdAccountSummary | null>
    try {
      live = await fetchMetaAdAccounts(
        groupRows.map((r) => r.external_account_id),
        scope,
      )
    } catch {
      continue // credentials not configured — every row in the set fails
    }
    groupRows.forEach((row, i) => {
      const m = live[i]
      if (m) byId.set(row.id, m)
    })
  }

  const refreshedAt = new Date().toISOString()
  let renamed = 0
  for (const row of rows) {
    const m = byId.get(row.id)
    if (!m) continue
    const { error } = await admin
      .from('ad_accounts')
      .update({
        meta_amount_spent: m.amount_spent,
        meta_spend_cap: m.spend_cap,
        meta_balance: m.meta_balance,
        meta_currency: m.currency,
        meta_refreshed_at: refreshedAt,
      })
      .eq('id', row.id)
    if (error) throw new Error(error.message)

    if (rename && m.name && m.name !== row.name) {
      const result = await syncAdAccountName(
        row.id,
        row.name,
        m.name,
        rename.actorUserId,
        'META_MANUAL_SYNC',
        await rename.auditOrganizationId(row),
      )
      if (result.renamed) renamed++
    }
  }

  return { byId, refreshed: byId.size, failed: rows.length - byId.size, renamed }
}
