import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyAdmins } from '@/server/notifications/notification.service'
import { listMetaBusinessAdAccounts } from '@/server/meta/meta.server'

/**
 * Unattended Meta → Rush Tracker sync — invoked by the `/api/cron/meta-sync`
 * Nitro route (server/api/cron/meta-sync.ts), not by a logged-in admin, so
 * there is no session for requireAdmin() to check. Authorization for this
 * path is the CRON_SECRET header check done by the route before calling
 * this function; never call it from user-reachable code.
 *
 * Scope is deliberately narrow:
 * - Renames a linked account's `name` when Meta's live name differs — safe
 *   to automate, no financial impact, audited as AD_ACCOUNT_RENAMED with
 *   metadata.source = 'META_SYNC'.
 * - Never auto-creates ad_accounts rows for newly-seen Meta accounts — that
 *   requires a usd_rate decision and current_limit_usd baseline (spec §20),
 *   both financial and admin-owned. New accounts are only counted and
 *   surfaced via notification; an admin imports them explicitly via the
 *   existing "Import from Meta" dialog.
 */
export interface MetaSyncResult {
  checked: number
  renamed: Array<{ id: string; account_code: string; old_name: string; new_name: string }>
  new_available: number
}

export async function syncMetaAdAccounts(): Promise<MetaSyncResult> {
  const metaAccounts = await listMetaBusinessAdAccounts()
  const admin = getSupabaseAdminClient()

  const { data: linked, error } = await admin
    .from('ad_accounts')
    .select('id, account_code, name, external_account_id')
    .not('external_account_id', 'is', null)
  if (error) throw new Error(error.message)

  const linkedByExternalId = new Map(
    (linked ?? []).map((row) => [row.external_account_id as string, row]),
  )

  const renamed: MetaSyncResult['renamed'] = []
  let newAvailable = 0

  for (const meta of metaAccounts) {
    const row = linkedByExternalId.get(meta.external_account_id)
    if (!row) {
      newAvailable++
      continue
    }
    if (meta.name && meta.name !== row.name) {
      const { error: updateError } = await admin
        .from('ad_accounts')
        .update({ name: meta.name })
        .eq('id', row.id)
      if (updateError) {
        console.error('[meta-sync] failed to rename', row.id, updateError)
        continue
      }
      await writeAudit({
        actorUserId: null, // system-initiated, no signed-in actor
        action: 'AD_ACCOUNT_RENAMED',
        entityType: 'AD_ACCOUNT',
        entityId: row.id,
        oldValues: { name: row.name },
        newValues: { name: meta.name },
        metadata: { source: 'META_SYNC' },
      })
      renamed.push({
        id: row.id,
        account_code: row.account_code,
        old_name: row.name,
        new_name: meta.name,
      })
    }
  }

  if (renamed.length > 0 || newAvailable > 0) {
    const parts: Array<string> = []
    if (renamed.length > 0) parts.push(`${renamed.length} account(s) renamed`)
    if (newAvailable > 0) parts.push(`${newAvailable} new account(s) available to import`)
    await notifyAdmins({
      type: 'META_SYNC',
      title: 'Meta Business Portfolio sync',
      message: parts.join(', ') + '.',
      entityType: 'AD_ACCOUNT',
    })
  }

  return { checked: metaAccounts.length, renamed, new_available: newAvailable }
}
