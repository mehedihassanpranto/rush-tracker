import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { writeAudit } from '@/server/audit/audit.service'
import { notifyAdmins } from '@/server/notifications/notification.service'
import { decideSpendCapSync } from '@/lib/meta/spend-cap-sync-decision'
import { fetchMetaAdAccount, updateMetaAdAccountSpendCap } from './meta.server'
import type { AdAccount } from '@/types/domain'

/**
 * Auto-push an approved limit to the linked Meta ad account's spend_cap
 * (post-Phase-8 addition). Two layers, split for testability:
 *
 * - syncAdAccountSpendCap: the Meta-calling core. No Supabase access — takes
 *   an already-loaded account, returns an outcome. This is what's unit
 *   tested with a mocked Meta client.
 * - syncAndPersistAdAccountSpendCap: loads the account, calls the core,
 *   persists meta_sync_pending/meta_sync_error/meta_sync_attempted_at,
 *   audits on success, notifies admins + logs on failure. Best-effort, like
 *   notify()/writeAudit() — never throws, so it can never block or fail the
 *   caller's primary operation (e.g. approving a limit request).
 */

export interface SpendCapSyncOutcome {
  // 'already_synced' is distinct from 'synced' so the persistence layer
  // doesn't write a redundant audit row (and repeat the notification-free
  // no-op) when nothing actually changed — only a real write is audit-worthy.
  status: 'not_applicable' | 'synced' | 'already_synced' | 'failed'
  error?: string
}

const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastError
}

export async function syncAdAccountSpendCap(
  account: Pick<AdAccount, 'external_account_id' | 'current_limit_usd'>,
): Promise<SpendCapSyncOutcome> {
  const externalAccountId = account.external_account_id
  if (!externalAccountId) return { status: 'not_applicable' }

  try {
    const meta = await withRetry(() => fetchMetaAdAccount(externalAccountId))
    const decision = decideSpendCapSync({
      externalAccountId,
      liveCurrency: meta.currency,
      liveAmountSpentUsd: meta.amount_spent,
      liveSpendCapUsd: meta.spend_cap,
      targetLimitUsd: account.current_limit_usd,
    })

    switch (decision.action) {
      case 'not_applicable':
        return { status: 'not_applicable' }
      case 'already_synced':
        return { status: 'already_synced' }
      case 'would_pause_delivery':
        return {
          status: 'failed',
          error: `New limit ($${account.current_limit_usd}) is below the $${decision.amountSpentUsd} already spent on Meta — would pause delivery immediately. Resolve manually via "Edit spend cap".`,
        }
      case 'write':
        await withRetry(() =>
          updateMetaAdAccountSpendCap(externalAccountId, decision.targetUsd),
        )
        return { status: 'synced' }
    }
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Meta sync failed',
    }
  }
}

export async function syncAndPersistAdAccountSpendCap(
  adAccountId: string,
  opts: { actorUserId: string | null; source: string },
): Promise<SpendCapSyncOutcome['status']> {
  try {
    const admin = getSupabaseAdminClient()
    const { data: account, error } = await admin
      .from('ad_accounts')
      .select('id, name, account_code, external_account_id, current_limit_usd, organization_id')
      .eq('id', adAccountId)
      .maybeSingle()
    if (error || !account) {
      console.error('[meta-spend-cap-sync] account not found', adAccountId, error)
      return 'failed'
    }

    const outcome = await syncAdAccountSpendCap(account)
    const now = new Date().toISOString()

    if (outcome.status === 'synced' || outcome.status === 'already_synced') {
      await admin
        .from('ad_accounts')
        .update({
          meta_sync_pending: false,
          meta_sync_error: null,
          meta_sync_attempted_at: now,
        })
        .eq('id', adAccountId)
      // Only a real write is audit-worthy — an already-in-sync confirmation
      // isn't a state change and shouldn't produce a duplicate-looking
      // AD_ACCOUNT_UPDATED row every time a retry or duplicate trigger fires.
      if (outcome.status === 'synced') {
        await writeAudit({
          actorUserId: opts.actorUserId,
          action: 'AD_ACCOUNT_UPDATED',
          entityType: 'AD_ACCOUNT',
          entityId: adAccountId,
          newValues: {
            current_limit_usd: account.current_limit_usd,
            meta_spend_cap: account.current_limit_usd,
          },
          metadata: { source: opts.source },
          organizationId: account.organization_id,
        })
      }
      return outcome.status
    }

    if (outcome.status === 'not_applicable') {
      // Clears a stale pending flag if the account became not_applicable
      // since the last attempt (e.g. unlinked from Meta in the meantime).
      await admin
        .from('ad_accounts')
        .update({ meta_sync_pending: false, meta_sync_error: null })
        .eq('id', adAccountId)
      return 'not_applicable'
    }

    // failed
    await admin
      .from('ad_accounts')
      .update({
        meta_sync_pending: true,
        meta_sync_error: outcome.error ?? 'Meta sync failed',
        meta_sync_attempted_at: now,
      })
      .eq('id', adAccountId)
    console.error('[meta-spend-cap-sync] failed', adAccountId, outcome.error)
    await notifyAdmins({
      type: 'META_SPEND_CAP_SYNC_FAILED',
      title: `Meta spend cap out of sync: ${account.name}`,
      message: `${account.account_code}: ${outcome.error ?? 'Meta sync failed'}`,
      entityType: 'AD_ACCOUNT',
      entityId: adAccountId,
      organizationId: account.organization_id,
    })
    return 'failed'
  } catch (err) {
    console.error('[meta-spend-cap-sync] unexpected failure', adAccountId, err)
    return 'failed'
  }
}

/** Retries every ad account currently flagged out-of-sync. Called from the
 * daily /api/cron/meta-sync job — no dedicated cron entry (see plan). */
export async function retryPendingMetaSpendCapSyncs(): Promise<{
  retried: number
  stillFailed: number
}> {
  const admin = getSupabaseAdminClient()
  const { data: pending, error } = await admin
    .from('ad_accounts')
    .select('id')
    .eq('meta_sync_pending', true)
  if (error) throw new Error(error.message)

  let stillFailed = 0
  for (const row of pending ?? []) {
    const status = await syncAndPersistAdAccountSpendCap(row.id as string, {
      actorUserId: null,
      source: 'META_SPEND_CAP_AUTO_SYNC',
    })
    if (status === 'failed') stillFailed++
  }
  return { retried: pending?.length ?? 0, stillFailed }
}
