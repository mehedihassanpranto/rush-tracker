import { writeAudit } from '@/server/audit/audit.service'
import {
  adAccountScope,
  applyAdAccountScope,
} from '@/server/ad-accounts/scope.server'
import { accountsOffRate } from '@/lib/money/usd-rate'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SessionUser } from '@/lib/auth/types'

/**
 * Set `rate` on every ad account actively assigned to the client that isn't
 * already on it. Past limit requests keep the rate they were approved at
 * (approved_usd_rate); only requests approved from now on use the new one.
 */
export async function applyRateToClientAccounts(
  admin: SupabaseClient,
  actor: SessionUser,
  clientId: string,
  rate: number,
): Promise<number> {
  const { data: assignments, error: assignmentError } = await admin
    .from('ad_account_assignments')
    .select('ad_account_id')
    .eq('client_id', clientId)
    .eq('status', 'ACTIVE')
    .eq('organization_id', actor.organizationId)
  if (assignmentError) throw new Error(assignmentError.message)
  const ids = (assignments ?? []).map((a) => a.ad_account_id as string)
  if (ids.length === 0) return 0

  // Owned or granted — a pool account's organization_id is NULL.
  const scope = await adAccountScope(admin, actor.organizationId)
  const { data: accounts, error: accountError } = await applyAdAccountScope(
    admin.from('ad_accounts').select('id, usd_rate').in('id', ids),
    scope,
  )
  if (accountError) throw new Error(accountError.message)
  const stale = accountsOffRate(
    (accounts ?? []) as Array<{ id: string; usd_rate: string | number | null }>,
    rate,
  )
  if (stale.length === 0) return 0

  const { error } = await applyAdAccountScope(
    admin
      .from('ad_accounts')
      .update({ usd_rate: rate })
      .in('id', stale.map((a) => a.id)),
    scope,
  )
  if (error) throw new Error(error.message)

  await Promise.all(
    stale.map((a) =>
      writeAudit({
        actorUserId: actor.id,
        organizationId: actor.organizationId,
        action: 'AD_ACCOUNT_UPDATED',
        entityType: 'AD_ACCOUNT',
        entityId: a.id,
        oldValues: { usd_rate: a.usd_rate },
        newValues: { usd_rate: rate },
        metadata: { source: 'CLIENT_RATE_APPLIED', client_id: clientId },
      }),
    ),
  )
  return stale.length
}
