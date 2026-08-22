import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyAdmins } from '@/server/notifications/notification.service'
import { listMetaBusinessAdAccounts, metaStatusLabel } from '@/server/meta/meta.server'
import { sendTelegramMessage } from '@/server/telegram/telegram.service'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
import { dec, formatCurrencyAmount } from '@/lib/money/money'

const META_DISABLED_STATUS_CODE = 2

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
/**
 * Renames one linked account's `name` to match Meta's live value, if it
 * actually differs — the single-account building block shared by the bulk
 * cron sync below and the manual per-account/per-list "Fetch"/"Refresh"
 * actions (meta.fns.ts's syncAdAccountNameFn). Same safe, non-financial
 * auto-apply semantics either way; only the audit `metadata.source` and
 * `actorUserId` differ (system vs. a signed-in admin).
 */
export async function syncAdAccountName(
  accountId: string,
  currentName: string,
  metaName: string | null,
  actorUserId: string | null,
  source: 'META_SYNC' | 'META_MANUAL_SYNC',
): Promise<{ renamed: boolean; newName?: string }> {
  if (!metaName || metaName === currentName) return { renamed: false }
  const admin = getSupabaseAdminClient()
  const { error } = await admin
    .from('ad_accounts')
    .update({ name: metaName })
    .eq('id', accountId)
  if (error) throw new Error(error.message)

  await writeAudit({
    actorUserId,
    action: 'AD_ACCOUNT_RENAMED',
    entityType: 'AD_ACCOUNT',
    entityId: accountId,
    oldValues: { name: currentName },
    newValues: { name: metaName },
    metadata: { source },
  })
  return { renamed: true, newName: metaName }
}

export interface MetaSyncResult {
  checked: number
  renamed: Array<{ id: string; account_code: string; old_name: string; new_name: string }>
  new_available: number
  newly_disabled: Array<{ id: string; account_code: string; name: string }>
  newly_low_balance: Array<{ id: string; account_code: string; name: string; remaining: string | null }>
}

interface AlertCheckRow {
  meta_last_status_code: number | null
  meta_low_balance_alerted: boolean
}

/**
 * Detects the two Meta-side transitions this cron Telegram-alerts on: newly
 * Disabled, and newly crossed LOW_BALANCE_THRESHOLD. Compares against the
 * account's last-persisted state (meta_last_status_code /
 * meta_low_balance_alerted) so each transition alerts exactly once, not
 * every cron run for as long as the account stays in that state.
 */
function checkAdAccountAlerts(
  row: AlertCheckRow,
  meta: { meta_status_code: number | null; spend_cap: string | null; amount_spent: string | null; currency: string | null },
): { newlyDisabled: boolean; newlyLow: boolean; isLowNow: boolean; remaining: string | null } {
  const newlyDisabled =
    meta.meta_status_code === META_DISABLED_STATUS_CODE &&
    row.meta_last_status_code !== META_DISABLED_STATUS_CODE

  // Same currency-native, USD-only gate as the display bell (no FX
  // conversion path in this integration) — see LOW_BALANCE_THRESHOLD's doc.
  const isUsd = meta.currency === 'USD'
  const remaining =
    meta.spend_cap != null
      ? dec(meta.spend_cap).minus(dec(meta.amount_spent ?? 0)).toFixed(2)
      : null
  const isLowNow = isUsd && remaining != null && dec(remaining).lte(LOW_BALANCE_THRESHOLD)
  const newlyLow = isLowNow && !row.meta_low_balance_alerted

  return { newlyDisabled, newlyLow, isLowNow, remaining }
}

export async function syncMetaAdAccounts(): Promise<MetaSyncResult> {
  const metaAccounts = await listMetaBusinessAdAccounts()
  const admin = getSupabaseAdminClient()

  const { data: linked, error } = await admin
    .from('ad_accounts')
    .select(
      'id, account_code, name, external_account_id, meta_last_status_code, meta_low_balance_alerted',
    )
    .not('external_account_id', 'is', null)
  if (error) throw new Error(error.message)

  const linkedByExternalId = new Map(
    (linked ?? []).map((row) => [row.external_account_id as string, row]),
  )

  const renamed: MetaSyncResult['renamed'] = []
  const newlyDisabledList: MetaSyncResult['newly_disabled'] = []
  const newlyLowList: MetaSyncResult['newly_low_balance'] = []
  let newAvailable = 0

  for (const meta of metaAccounts) {
    const row = linkedByExternalId.get(meta.external_account_id)
    if (!row) {
      newAvailable++
      continue
    }

    let currentName = row.name
    try {
      const result = await syncAdAccountName(
        row.id,
        row.name,
        meta.name,
        null, // system-initiated, no signed-in actor
        'META_SYNC',
      )
      if (result.renamed && result.newName) {
        currentName = result.newName
        renamed.push({
          id: row.id,
          account_code: row.account_code,
          old_name: row.name,
          new_name: result.newName,
        })
      }
    } catch (err) {
      console.error('[meta-sync] failed to rename', row.id, err)
    }

    const { newlyDisabled, newlyLow, isLowNow, remaining } = checkAdAccountAlerts(
      row,
      meta,
    )

    const { error: stateError } = await admin
      .from('ad_accounts')
      .update({
        meta_last_status_code: meta.meta_status_code,
        meta_low_balance_alerted: isLowNow,
      })
      .eq('id', row.id)
    if (stateError) {
      console.error('[meta-sync] failed to persist alert state', row.id, stateError)
    }

    if (newlyDisabled) {
      newlyDisabledList.push({ id: row.id, account_code: row.account_code, name: currentName })
      await sendTelegramMessage(
        `🚫 Ad account ${row.account_code} "${currentName}" was disabled on Meta (status: ${metaStatusLabel(meta.meta_status_code)}).`,
      )
    }
    if (newlyLow) {
      newlyLowList.push({
        id: row.id,
        account_code: row.account_code,
        name: currentName,
        remaining,
      })
      await sendTelegramMessage(
        `⚠️ Ad account ${row.account_code} "${currentName}" is low on Meta spend headroom: ${formatCurrencyAmount(remaining, meta.currency)} remaining (threshold: ${LOW_BALANCE_THRESHOLD}).`,
      )
    }
  }

  if (
    renamed.length > 0 ||
    newAvailable > 0 ||
    newlyDisabledList.length > 0 ||
    newlyLowList.length > 0
  ) {
    const parts: Array<string> = []
    if (renamed.length > 0) parts.push(`${renamed.length} account(s) renamed`)
    if (newAvailable > 0) parts.push(`${newAvailable} new account(s) available to import`)
    if (newlyDisabledList.length > 0) parts.push(`${newlyDisabledList.length} newly disabled`)
    if (newlyLowList.length > 0) parts.push(`${newlyLowList.length} newly low on balance`)
    await notifyAdmins({
      type: 'META_SYNC',
      title: 'Meta Business Portfolio sync',
      message: parts.join(', ') + '.',
      entityType: 'AD_ACCOUNT',
    })
  }

  return {
    checked: metaAccounts.length,
    renamed,
    new_available: newAvailable,
    newly_disabled: newlyDisabledList,
    newly_low_balance: newlyLowList,
  }
}
