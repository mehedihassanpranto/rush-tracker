/**
 * Which credential set a given ad account's Meta API calls must use.
 *
 * Credentials are resolved per ACCOUNT, never per "the current organization" —
 * an agency can hold a mix of accounts it connected itself (its own Business
 * Portfolio, its own token) and accounts granted to it from the platform pool
 * (the platform's portfolio, the platform's token). Calling Meta for a granted
 * account with the agency's own token would simply fail: that account isn't in
 * their portfolio.
 *
 * The two scopes are a union rather than both being organization ids, because
 * **the platform is not an organization**. It has no subscription, no clients
 * and no ledger, and its credentials live in `platform_settings`, a table with
 * no organization_id at all (migration 000037). Modelling the platform as org
 * zero — which is what this returned before — is what let xRush Agency's own
 * Settings screen edit the credentials for a portfolio it does not own.
 */
export type MetaCredentialScope =
  | { kind: 'platform' }
  | { kind: 'organization'; organizationId: string }

export const PLATFORM_CREDENTIALS: MetaCredentialScope = { kind: 'platform' }

export function organizationCredentials(
  organizationId: string,
): MetaCredentialScope {
  return { kind: 'organization', organizationId }
}

/** Stable key for deduping scopes (one bulk fetch per distinct credential set). */
export function credentialScopeKey(scope: MetaCredentialScope): string {
  return scope.kind === 'platform' ? 'platform' : `org:${scope.organizationId}`
}

export function metaCredentialScopeFor(account: {
  is_platform: boolean
  organization_id: string | null
}): MetaCredentialScope {
  if (account.is_platform) return PLATFORM_CREDENTIALS
  if (!account.organization_id) {
    // The ad_accounts_ownership_ck constraint makes this unreachable; if it
    // ever fires, failing loudly beats silently using the platform's token.
    throw new Error('Ad account has no owning organization and is not platform-owned')
  }
  return organizationCredentials(account.organization_id)
}

/**
 * The PostgREST `or` filter selecting every ad account one agency may use:
 * the ones it owns, plus the platform-pool accounts granted to it.
 *
 * Returns null when the agency holds no grants — the caller then uses a plain
 * `.eq('organization_id', …)`, because PostgREST rejects an empty `in.()` list.
 */
export function adAccountScopeFilter(
  organizationId: string,
  grantedAccountIds: Array<string>,
): string | null {
  if (grantedAccountIds.length === 0) return null
  return `organization_id.eq.${organizationId},id.in.(${grantedAccountIds.join(',')})`
}
