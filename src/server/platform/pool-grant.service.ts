import type { SupabaseClient } from '@supabase/supabase-js'
import { writeAudit } from '@/server/audit/audit.service'

/**
 * Grants one platform-pool account to one agency. Shared by the manual
 * "Grant" action on the pool panel (grantPoolAccountFn, pool.fns.ts) and by
 * fulfilling an agency's account request (fulfillAccountRequestFn,
 * account-requests.fns.ts) — both must do exactly the same checks and write
 * the same audit row, so it lives in one place.
 *
 * A plain service module rather than an exported helper inside a .fns.ts
 * file: a second .fns.ts importing a helper by name defeats the bundler's
 * proof that it is server-only (see limit-request-approval.service.ts). The
 * admin client is passed in for the same reason — this file touches no
 * .server.ts module directly.
 *
 * The UNIQUE constraint on platform_account_grants.ad_account_id is the real
 * guard against double-granting; the lookup below only exists so the caller
 * gets a message naming the agency that already holds the account instead of
 * a raw constraint error.
 */
export async function grantPoolAccountToOrganization(
  admin: SupabaseClient,
  actor: { id: string; organizationId: string },
  adAccountId: string,
  organizationId: string,
): Promise<{ accountCode: string; accountName: string }> {
  const { data: account } = await admin
    .from('ad_accounts')
    .select('id, account_code, name, is_platform')
    .eq('id', adAccountId)
    .maybeSingle()
  if (!account) throw new Error('Ad account not found')
  if (!(account as { is_platform: boolean }).is_platform) {
    throw new Error(
      'That account belongs to an agency, not the platform pool — it cannot be granted.',
    )
  }

  const { data: org } = await admin
    .from('organizations')
    .select('id, name')
    .eq('id', organizationId)
    .maybeSingle()
  if (!org) throw new Error('Organization not found')

  const { data: existing } = await admin
    .from('platform_account_grants')
    .select('organization_id, organization:organizations(name)')
    .eq('ad_account_id', adAccountId)
    .maybeSingle()
  if (existing) {
    const holder = (
      existing as unknown as { organization: { name: string } | null }
    ).organization?.name
    throw new Error(
      `That account is already granted to ${holder ?? 'another agency'}. Revoke it first.`,
    )
  }

  const { error } = await admin.from('platform_account_grants').insert({
    ad_account_id: adAccountId,
    organization_id: organizationId,
    granted_by: actor.id,
  })
  if (error) throw new Error(error.message)

  const accountCode = (account as { account_code: string }).account_code
  const accountName = (account as { name: string }).name
  await writeAudit({
    actorUserId: actor.id,
    organizationId: actor.organizationId,
    action: 'PLATFORM_ACCOUNT_GRANTED',
    entityType: 'AD_ACCOUNT',
    entityId: adAccountId,
    newValues: {
      account_code: accountCode,
      account_name: accountName,
      organization_id: organizationId,
      organization_name: (org as { name: string }).name,
    },
  })
  return { accountCode, accountName }
}
