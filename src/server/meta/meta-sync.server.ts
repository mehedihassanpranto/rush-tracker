import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyAdmins } from '@/server/notifications/notification.service'
import {
  isMetaConfigured,
  listMetaBusinessAdAccounts,
  metaStatusLabel,
} from '@/server/meta/meta.server'
import { notifyTelegram } from '@/server/telegram/telegram.service'
import { DEPLOYMENT_ORGANIZATION_ID } from '@/lib/organizations/deployment-org'
import {
  PLATFORM_CREDENTIALS,
  organizationCredentials,
} from '@/lib/meta/credential-scope'
import type { MetaCredentialScope } from '@/lib/meta/credential-scope'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
import { operatingOrganizationId } from '@/server/ad-accounts/scope.server'
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
  // The organization the AUDIT row belongs to — the operating agency, which
  // for a platform-pool account is the one holding the grant, not the (NULL)
  // owner. Access is authorized by the caller before this is reached, so the
  // update matches on id alone.
  auditOrganizationId: string,
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
    organizationId: auditOrganizationId,
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

/**
 * Sync ONE Business Portfolio against the ad_accounts rows that live in it.
 *
 * The unit of work is a CREDENTIAL SET, not an agency, because the two stopped
 * being the same thing when the platform pool landed:
 *   - an agency's own credentials cover the accounts it owns
 *     (`organization_id = them`, `is_platform = false`)
 *   - the platform's credentials (the deployment's META_* env vars) cover the
 *     whole pool (`is_platform = true`), whoever each account is granted to
 * Comparing a portfolio against rows it does not contain would report every
 * one of them as "new to import" and never rename any of them.
 */
async function syncCredentialSet(
  scope: MetaCredentialScope,
): Promise<MetaSyncResult> {
  // The scope IS the unit of work, so it also decides which rows to compare
  // against — deriving this rather than taking a second parameter removes any
  // way to pass a portfolio and a row set that don't belong together.
  const platformPool = scope.kind === 'platform'
  const credentialOrgId = platformPool ? null : scope.organizationId
  const metaAccounts = await listMetaBusinessAdAccounts(scope)
  const admin = getSupabaseAdminClient()

  let query = admin
    .from('ad_accounts')
    .select(
      'id, account_code, name, external_account_id, meta_last_status_code, meta_low_balance_alerted, organization_id, is_platform',
    )
    .not('external_account_id', 'is', null)
  query = platformPool
    ? query.eq('is_platform', true)
    : query.eq('organization_id', credentialOrgId!).eq('is_platform', false)
  const { data: linked, error } = await query
  if (error) throw new Error(error.message)

  const linkedByExternalId = new Map(
    (linked ?? []).map((row) => [row.external_account_id as string, row]),
  )

  const renamed: MetaSyncResult['renamed'] = []
  const newlyDisabledList: MetaSyncResult['newly_disabled'] = []
  const newlyLowList: MetaSyncResult['newly_low_balance'] = []
  const accountOrgs = new Map<string, string>()
  let newAvailable = 0

  for (const meta of metaAccounts) {
    const row = linkedByExternalId.get(meta.external_account_id)
    if (!row) {
      newAvailable++
      continue
    }

    // A pool account has no owner of its own; its audit trail belongs to the
    // agency currently holding the grant (falling back to the platform's own
    // organization while it is ungranted).
    // holderOrg is null only for an ungranted pool account — used below to
    // send its Telegram alerts to the platform rather than to any agency.
    const holderOrg = await operatingOrganizationId(admin, row)
    const operatingOrg = holderOrg ?? DEPLOYMENT_ORGANIZATION_ID
    accountOrgs.set(row.id, operatingOrg)

    let currentName = row.name
    try {
      const result = await syncAdAccountName(
        row.id,
        row.name,
        meta.name,
        null, // system-initiated, no signed-in actor
        'META_SYNC',
        operatingOrg,
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
      await alertTelegram(
        holderOrg,
        'meta.account_disabled',
        row.id,
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
      await alertTelegram(
        holderOrg,
        'meta.low_balance',
        row.id,
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
    // notifyAdmins fans out within ONE organization. For an agency's own
    // portfolio that is simply that agency. For the platform pool the touched
    // accounts can belong to several agencies at once, so the digest goes to
    // each of them — never a broadcast across tenants.
    const recipients = platformPool
      ? [...new Set(accountOrgs.values())]
      : [credentialOrgId!]
    const target = recipients.length > 0 ? recipients : [DEPLOYMENT_ORGANIZATION_ID]
    for (const organizationId of target) {
      await notifyAdmins({
        type: 'META_SYNC',
        title: platformPool
          ? 'Platform pool Meta sync'
          : 'Meta Business Portfolio sync',
        message: parts.join(', ') + '.',
        entityType: 'AD_ACCOUNT',
        organizationId,
      })
    }
  }

  return {
    checked: metaAccounts.length,
    renamed,
    new_available: newAvailable,
    newly_disabled: newlyDisabledList,
    newly_low_balance: newlyLowList,
  }
}

/**
 * Disabled / low-balance alerts go to the agency that USES the account — the
 * owner for an agency's own account, the grant holder for a pool account —
 * and to the platform admins only for a pool account nobody holds yet.
 *
 * This replaces the old org-zero-only gate. That gate existed because there
 * was one deployment-wide chat belonging to xRush, so another agency's
 * account names could not be sent there; with per-recipient subscriptions
 * each agency's alerts reach only that agency's own linked chats, so every
 * agency now gets them (spec §5.1, "Meta Due" alert).
 */
async function alertTelegram(
  holderOrganizationId: string | null,
  eventType: string,
  adAccountId: string,
  text: string,
) {
  await notifyTelegram({
    eventType,
    recipient: holderOrganizationId
      ? { type: 'agency', organizationId: holderOrganizationId }
      : { type: 'platform_admin' },
    text,
    payload: { ad_account_id: adAccountId },
  })
}

export interface MetaSyncOrganizationResult extends MetaSyncResult {
  /** null for the platform pool — it is a credential set, not an agency. */
  organization_id: string | null
  organization_name: string
}

export interface MetaSyncRunResult {
  organizations: Array<MetaSyncOrganizationResult>
  /** Agencies deliberately not synced, and why — a connected-but-broken
   * portfolio is an error, but "hasn't connected one" is normal. */
  skipped: Array<{
    organization_id: string | null
    organization_name: string
    reason: 'not_configured' | 'failed'
    error?: string
  }>
}

/**
 * Unattended daily sync across every subscribing agency AND the platform pool.
 *
 * Each agency is synced against its own Business Portfolio using its own
 * credentials, and the pool is synced once against the platform's, and one agency's failure never stops the others — a bad or
 * expired token belongs to that customer, and must not silently stop
 * everybody else's accounts from syncing.
 *
 * Suspended/cancelled agencies are skipped entirely: their users can't reach
 * the app at all, so acting on their Meta account on their behalf (and
 * spending their API quota) every night would be wrong.
 */
export async function syncMetaAdAccounts(): Promise<MetaSyncRunResult> {
  const admin = getSupabaseAdminClient()
  const { data: orgs, error } = await admin
    .from('organizations')
    .select('id, name')
    .eq('subscription_status', 'active')
  if (error) throw new Error(error.message)

  const organizations: MetaSyncRunResult['organizations'] = []
  const skipped: MetaSyncRunResult['skipped'] = []

  for (const org of (orgs ?? []) as Array<{ id: string; name: string }>) {
    if (!(await isMetaConfigured(organizationCredentials(org.id)))) {
      skipped.push({
        organization_id: org.id,
        organization_name: org.name,
        reason: 'not_configured',
      })
      continue
    }
    try {
      const result = await syncCredentialSet(organizationCredentials(org.id))
      organizations.push({
        ...result,
        organization_id: org.id,
        organization_name: org.name,
      })
    } catch (err) {
      console.error('[meta-sync] organization failed', org.id, err)
      skipped.push({
        organization_id: org.id,
        organization_name: org.name,
        reason: 'failed',
        error: err instanceof Error ? err.message : 'Meta sync failed',
      })
    }
  }

  // The platform pool is its own credential set, synced once regardless of how
  // many agencies hold grants — the accounts all live in one portfolio, so one
  // pass covers them. Runs even if no agency has grants yet, so ungranted pool
  // accounts still get their names and alert state kept current.
  if (await isMetaConfigured(PLATFORM_CREDENTIALS)) {
    try {
      const result = await syncCredentialSet(PLATFORM_CREDENTIALS)
      organizations.push({
        ...result,
        organization_id: null,
        organization_name: 'Platform pool',
      })
    } catch (err) {
      console.error('[meta-sync] platform pool failed', err)
      skipped.push({
        organization_id: null,
        organization_name: 'Platform pool',
        reason: 'failed',
        error: err instanceof Error ? err.message : 'Meta sync failed',
      })
    }
  } else {
    skipped.push({
      organization_id: null,
      organization_name: 'Platform pool',
      reason: 'not_configured',
    })
  }

  return { organizations, skipped }
}
