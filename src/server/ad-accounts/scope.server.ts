import { adAccountScopeFilter } from '@/lib/meta/credential-scope'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The one place that answers "which ad accounts may this agency use?".
 *
 * Since the platform-owned pool landed, that is no longer just
 * `organization_id = <them>`. It is the union of:
 *   (a) accounts the agency owns outright — they connected their own Meta
 *       credentials and imported them; and
 *   (b) platform-pool accounts (`is_platform`) granted to them in
 *       `platform_account_grants`.
 *
 * Every server function that reads or writes ad accounts routes through here
 * rather than re-deriving the rule, so there is a single definition to audit —
 * the multi-tenant pass spread `.eq('organization_id', …)` across ~10 files by
 * hand, and a union repeated that many times would drift.
 *
 * A granted account is operable exactly like an owned one by the agency
 * holding the grant (assign to clients, limit requests, spend caps, edit).
 * That equivalence is deliberate: xRush's entire fleet moved into the pool and
 * was granted back, so anything less would regress its day-to-day work.
 * Ownership still differs in one way — the platform can revoke a grant, which
 * removes the account from that agency instantly.
 */

/** Ids of the pool accounts currently granted to one agency. */
export async function grantedAccountIds(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Array<string>> {
  const { data, error } = await admin
    .from('platform_account_grants')
    .select('ad_account_id')
    .eq('organization_id', organizationId)
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => r.ad_account_id as string)
}

export interface AdAccountScope {
  organizationId: string
  /** null when the agency holds no grants — use a plain equality filter. */
  filter: string | null
}

/** Resolve the scope once, then apply it to as many queries as needed. */
export async function adAccountScope(
  admin: SupabaseClient,
  organizationId: string,
): Promise<AdAccountScope> {
  const granted = await grantedAccountIds(admin, organizationId)
  return { organizationId, filter: adAccountScopeFilter(organizationId, granted) }
}

/**
 * Apply the owned-or-granted scope to an `ad_accounts` query.
 *
 * Synchronous on purpose: a PostgREST query builder is thenable, so an async
 * applier would be awaited by its caller and execute the query before
 * `.order()`/`.in()` could be chained onto it.
 */
export function applyAdAccountScope<T>(query: T, scope: AdAccountScope): T {
  const q = query as unknown as {
    eq: (c: string, v: string) => T
    or: (f: string) => T
  }
  return scope.filter === null
    ? q.eq('organization_id', scope.organizationId)
    : q.or(scope.filter)
}

/** One-shot convenience for the common single-query case. */
export async function scopedAdAccountQuery<T>(
  query: T,
  admin: SupabaseClient,
  organizationId: string,
): Promise<T> {
  return applyAdAccountScope(query, await adAccountScope(admin, organizationId))
}

export interface AccessibleAccount {
  id: string
  is_platform: boolean
  organization_id: string | null
}

/**
 * Load one ad account the agency is allowed to act on, or throw.
 *
 * Replaces the `.eq('id', x).eq('organization_id', me)` pair used before the
 * pool existed — that pattern now silently misses every granted account, whose
 * `organization_id` is NULL. Returns the ownership fields so callers can
 * resolve the right Meta credentials via metaCredentialOrgFor().
 *
 * The error message deliberately matches the old "not found" wording: whether
 * an id exists but belongs to someone else should not be distinguishable.
 */
export async function loadAccessibleAdAccount(
  admin: SupabaseClient,
  adAccountId: string,
  organizationId: string,
  columns = 'id, is_platform, organization_id',
): Promise<Record<string, unknown> & AccessibleAccount> {
  const { data, error } = await admin
    .from('ad_accounts')
    .select(columns)
    .eq('id', adAccountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const account = data as (Record<string, unknown> & AccessibleAccount) | null
  if (!account) throw new Error('Ad account not found')

  if (account.organization_id === organizationId) return account
  if (account.is_platform) {
    const { data: grant } = await admin
      .from('platform_account_grants')
      .select('id')
      .eq('ad_account_id', adAccountId)
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (grant) return account
  }
  throw new Error('Ad account not found')
}

/**
 * The organization that OPERATES an account day to day — the one whose admins
 * should be notified about it and whose organization_id belongs on its audit
 * rows. For an owned account that is its owner; for a platform-pool account it
 * is whichever agency currently holds the grant.
 *
 * Needed because `audit_logs.organization_id` and `notifyAdmins()` are both
 * NOT NULL, while a pool account's own `organization_id` is NULL by design.
 * Returns null for an ungranted pool account (nobody operates it yet).
 */
export async function operatingOrganizationId(
  admin: SupabaseClient,
  account: { id: string; is_platform: boolean; organization_id: string | null },
): Promise<string | null> {
  if (!account.is_platform) return account.organization_id
  const { data } = await admin
    .from('platform_account_grants')
    .select('organization_id')
    .eq('ad_account_id', account.id)
    .maybeSingle()
  return (data as { organization_id: string } | null)?.organization_id ?? null
}
