import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin, requireClientMembership } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { dec } from '@/lib/money/money'
import {
  applyMetaSpendCapSchema,
  fetchMetaAdAccountSchema,
  importMetaAdAccountsSchema,
  retryMetaSpendCapSyncSchema,
  syncAdAccountNameSchema,
  updateMetaSpendCapSchema,
} from '@/schemas/meta'
import {
  fetchMetaAdAccount,
  listMetaBusinessAdAccounts,
  updateMetaAdAccountSpendCap,
} from '@/server/meta/meta.server'
import { syncAndPersistAdAccountSpendCap } from '@/server/meta/spend-cap-sync.server'
import { syncAdAccountName } from '@/server/meta/meta-sync.server'
import {
  adAccountScope,
  applyAdAccountScope,
  loadAccessibleAdAccount,
} from '@/server/ad-accounts/scope.server'
import {
  canMutateSpendCap,
  credentialScopeKey,
  metaCredentialScopeFor,
  organizationCredentials,
} from '@/lib/meta/credential-scope'
import type { MetaCredentialScope } from '@/lib/meta/credential-scope'
import type { MetaAdAccountSummary } from '@/server/meta/meta.server'
import type { AdAccount } from '@/types/domain'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Shared precondition for both spend-cap fns below: load the account row,
 * require it's linked to Meta, and require the live Meta currency is USD
 * (no FX conversion path here). Kept in one place so a future change to
 * this financial safety check (e.g. an allow-list of other currencies)
 * can't be applied to one call site and silently missed on the other.
 */
async function loadUsdLinkedAccount(
  admin: SupabaseClient,
  id: string,
  organizationId: string,
  actor: { isPlatformAdmin: boolean },
) {
  const account = await loadAccessibleAdAccount(admin, id, organizationId, '*')
  const before = account as unknown as AdAccount
  if (!before.external_account_id) {
    throw new Error('This account has no linked Meta external ID')
  }
  // The account's OWN owner decides who may push/pull its spend cap — see
  // canMutateSpendCap()'s doc comment for what stays unlocked (rename,
  // status, assign/release/transfer, limit-request approval all still work).
  if (!canMutateSpendCap(account as unknown as { is_platform: boolean }, actor)) {
    throw new Error(
      "This account's spend cap is managed by the platform — it was assigned to your agency, not connected through your own Meta credentials.",
    )
  }

  const externalAccountId: string = before.external_account_id
  // Credentials come from the account's OWN owner — a granted pool account
  // lives in the platform's portfolio, not this agency's.
  const meta = await fetchMetaAdAccount(
    externalAccountId,
    metaCredentialScopeFor(account),
  )
  if (meta.currency !== 'USD') {
    throw new Error(
      `Meta reports this account's currency as ${meta.currency ?? 'unknown'}, not USD — this app can't push/apply a limit for a non-USD account`,
    )
  }
  return { before, externalAccountId, meta, account }
}

export type MetaImportCandidate = MetaAdAccountSummary & {
  already_linked: boolean
  linked_account_id: string | null
  linked_account_code: string | null
}

/**
 * Fetches every distinct credential set once and merges the results by Meta
 * account id.
 *
 * An agency's accounts can span two Business Portfolios — the one it connected
 * itself and the platform's (for granted pool accounts) — and a pool account is
 * invisible to the agency's own token. Deduping by credential scope keeps this
 * at one bulk Graph call per portfolio (usually just one), never one per
 * account. A set that is unconfigured or unreachable contributes nothing rather
 * than failing the whole read: those rows simply report no live data.
 */
async function fetchAcrossCredentialSets(
  scopes: Array<MetaCredentialScope>,
): Promise<Map<string, MetaAdAccountSummary>> {
  const distinct = new Map<string, MetaCredentialScope>()
  for (const scope of scopes) distinct.set(credentialScopeKey(scope), scope)

  const byExternalId = new Map<string, MetaAdAccountSummary>()
  for (const scope of distinct.values()) {
    try {
      const fetched = await listMetaBusinessAdAccounts(scope)
      for (const m of fetched) byExternalId.set(m.external_account_id, m)
    } catch {
      // Meta not configured / unreachable for that set — graceful degradation.
    }
  }
  return byExternalId
}

// ===========================================================================
// Admin
// ===========================================================================

/** Fetch one Meta ad account's live details by account id — verify/prefill
 * use on the create form and the account detail page. Read-only. */
export const fetchMetaAdAccountFn = createServerFn({ method: 'POST' })
  .validator(fetchMetaAdAccountSchema)
  .handler(async ({ data }): Promise<MetaAdAccountSummary> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    // Two callers with different needs: the account detail page fetches live
    // data for an account that already exists here (which may be a granted
    // pool account, only reachable with the PLATFORM's token), and the create
    // dialog verifies an id that isn't in our database at all (necessarily the
    // agency's own portfolio). So the credential set comes from the linked row
    // when there is one, falling back to the agency's own.
    //
    // The lookup is scoped to accounts this agency may already use, so an
    // arbitrary external id can never be pointed at the platform's token.
    const scope = await adAccountScope(admin, actor.organizationId)
    const { data: linked } = await applyAdAccountScope(
      admin.from('ad_accounts').select('is_platform, organization_id'),
      scope,
    )
      .eq('external_account_id', data.external_account_id)
      .maybeSingle()

    return fetchMetaAdAccount(
      data.external_account_id,
      linked
        ? metaCredentialScopeFor(
            linked as { is_platform: boolean; organization_id: string | null },
          )
        : organizationCredentials(actor.organizationId),
    )
  })

/**
 * Applies Meta's live name to a linked account when it differs — the
 * manual, immediate counterpart to the daily background sync's
 * auto-rename (meta-sync.server.ts). Same safe, non-financial semantics:
 * always applies when different, no confirmation needed (unlike spend-cap
 * writes). Used by the ad account detail page's "Fetch" button and the ad
 * accounts list page's "Refresh" button once either notices a name
 * mismatch in the live Meta data they already fetched.
 */
export const syncAdAccountNameFn = createServerFn({ method: 'POST' })
  .validator(syncAdAccountNameSchema)
  .handler(async ({ data }): Promise<{ renamed: boolean; new_name: string | null }> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const account = await loadAccessibleAdAccount(
      admin,
      data.id,
      actor.organizationId,
      'id, is_platform, organization_id, name',
    )

    const result = await syncAdAccountName(
      data.id,
      (account as unknown as { name: string }).name,
      data.meta_name,
      actor.id,
      'META_MANUAL_SYNC',
      actor.organizationId,
    )
    return { renamed: result.renamed, new_name: result.newName ?? null }
  })

/**
 * Live Meta data for every ad account this agency can actually operate —
 * the ones it owns AND the platform-pool accounts granted to it.
 *
 * Distinct from listMetaBusinessAdAccountsFn below, which lists an agency's
 * own Business Portfolio for IMPORT. The two used to be the same call, and
 * that only worked while org zero's credentials and the platform's were the
 * same thing: once the platform's portfolio became its own credential scope
 * (migration 000037), an agency whose whole fleet is granted pool accounts —
 * xRush, with 34 of 34 — has no portfolio of its own to list, and every
 * Remaining / Meta Due / low-balance signal on the ad accounts list, the
 * clients list and the client detail page would have silently gone blank.
 *
 * Returns only accounts linked here, in MetaImportCandidate shape so the
 * display pages keep the `linked_account_id` they use to match rows and to
 * drive the Refresh button's name sync. Nothing unlinked is returned: the
 * platform's unimported inventory is not an agency's business.
 */
export const listUsableMetaAdAccountsFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Array<MetaImportCandidate>> => {
  const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
  const admin = getSupabaseAdminClient()

  const scope = await adAccountScope(admin, actor.organizationId)
  const { data: linked, error } = await applyAdAccountScope(
    admin
      .from('ad_accounts')
      .select('id, account_code, external_account_id, is_platform, organization_id'),
    scope,
  ).not('external_account_id', 'is', null)
  if (error) throw new Error(error.message)

  const rows = (linked ?? []) as Array<{
    id: string
    account_code: string
    external_account_id: string
    is_platform: boolean
    organization_id: string | null
  }>
  if (rows.length === 0) return []

  const byExternalId = await fetchAcrossCredentialSets(
    rows.map((r) => metaCredentialScopeFor(r)),
  )

  return rows.flatMap((row) => {
    const meta = byExternalId.get(row.external_account_id)
    if (!meta) return []
    return [
      {
        ...meta,
        already_linked: true,
        linked_account_id: row.id,
        linked_account_code: row.account_code,
      },
    ]
  })
})

/** List every ad account in the connected Business Portfolio, annotated with
 * whether it's already linked to an ad_accounts row here. */
export const listMetaBusinessAdAccountsFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Array<MetaImportCandidate>> => {
  const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
  // The agency's OWN portfolio: importing is how an agency adds accounts it
  // connected itself. Platform-pool accounts arrive by grant, never by import,
  // so they are deliberately not listed here.
  const metaAccounts = await listMetaBusinessAdAccounts(
    organizationCredentials(actor.organizationId),
  )

  const admin = getSupabaseAdminClient()
  const scope = await adAccountScope(admin, actor.organizationId)
  const { data: linked, error } = await applyAdAccountScope(
    admin.from('ad_accounts').select('id, account_code, external_account_id'),
    scope,
  ).in(
    'external_account_id',
    metaAccounts.map((a) => a.external_account_id),
  )
  if (error) throw new Error(error.message)

  const linkedById = new Map(
    (linked ?? []).map((row) => [
      row.external_account_id as string,
      row as { id: string; account_code: string },
    ]),
  )

  return metaAccounts.map((account) => {
    const match = linkedById.get(account.external_account_id)
    return {
      ...account,
      already_linked: Boolean(match),
      linked_account_id: match?.id ?? null,
      linked_account_code: match?.account_code ?? null,
    }
  })
})

/** Bulk-create ad_accounts rows from selected Meta ad accounts. Each row
 * starts AVAILABLE / unassigned with current_limit_usd 0 — Meta's spend_cap
 * is a different concept from our operational limit baseline (spec §20) and
 * is never auto-mapped onto it; admins set the real baseline via the normal
 * limit-request flow after import.
 *
 * Re-checks for already-linked external_account_ids immediately before
 * inserting (the import dialog's candidate list can be stale by the time an
 * admin submits — another admin, or a double-submit, may have imported one
 * of the same accounts in between). This narrows but doesn't eliminate the
 * race window; the unique partial index on external_account_id (migration
 * …0011) is the hard backstop — if the tiny remaining window is ever hit,
 * the insert fails with a clear constraint error instead of silently
 * creating a duplicate row for the same Meta account. */
export const importMetaAdAccountsFn = createServerFn({ method: 'POST' })
  .validator(importMetaAdAccountsSchema)
  .handler(async ({ data }): Promise<Array<AdAccount>> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: existing, error: existingError } = await admin
      .from('ad_accounts')
      .select('external_account_id')
      .in(
        'external_account_id',
        data.accounts.map((a) => a.external_account_id),
      )
    if (existingError) throw new Error(existingError.message)
    const alreadyLinked = new Set(
      (existing ?? []).map((r) => r.external_account_id as string),
    )
    const toInsert = data.accounts.filter(
      (a) => !alreadyLinked.has(a.external_account_id),
    )
    if (toInsert.length === 0) {
      throw new Error(
        'All selected accounts were already imported (likely by another admin just now) — nothing new to add.',
      )
    }

    const { data: accounts, error } = await admin
      .from('ad_accounts')
      .insert(
        toInsert.map((a) => ({
          name: a.name,
          external_account_id: a.external_account_id,
          platform: 'META',
          current_limit_usd: 0,
          usd_rate: data.usd_rate,
          status: 'AVAILABLE' as const,
          organization_id: actor.organizationId,
        })),
      )
      .select('*')

    if (error) throw new Error(error.message)

    for (const account of accounts ?? []) {
      await writeAudit({
        actorUserId: actor.id,
        organizationId: actor.organizationId,
        action: 'AD_ACCOUNT_CREATED',
        entityType: 'AD_ACCOUNT',
        entityId: account.id,
        newValues: account,
        metadata: { source: 'META_IMPORT' },
      })
    }
    return (accounts ?? []) as Array<AdAccount>
  })

/**
 * Apply a linked account's live Meta spend cap as its current_limit_usd
 * (spec §20's "opening balance" baseline for the *next* limit request — same
 * operational-baseline concept the Edit dialog already lets an admin set
 * directly, non-billing, no ledger entry). Re-fetches from Meta server-side
 * rather than trusting a client-supplied number (money rule: never trust
 * frontend-computed amounts).
 *
 * USD-only by design: spend_cap is denominated in the Meta account's own
 * currency, and this app has no FX conversion path for other currencies —
 * applying a non-USD figure as a USD baseline would silently misstate it.
 */
export const applyMetaSpendCapFn = createServerFn({ method: 'POST' })
  .validator(applyMetaSpendCapSchema)
  .handler(async ({ data }): Promise<AdAccount> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { before, meta } = await loadUsdLinkedAccount(
      admin,
      data.id,
      actor.organizationId,
      actor,
    )
    if (meta.spend_cap == null) {
      throw new Error('Meta reports no spend cap for this account')
    }

    const { data: account, error } = await admin
      .from('ad_accounts')
      .update({ current_limit_usd: meta.spend_cap })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'AD_ACCOUNT_UPDATED',
      entityType: 'AD_ACCOUNT',
      entityId: data.id,
      oldValues: { current_limit_usd: before.current_limit_usd },
      newValues: { current_limit_usd: meta.spend_cap },
      metadata: { source: 'META_SPEND_CAP' },
    })
    return account as AdAccount
  })

/**
 * Push a new spend_cap to Meta AND update our own current_limit_usd to
 * match (owner-directed: keep both sides in sync rather than letting them
 * silently disagree). The only WRITE this integration makes to Meta —
 * everything else here is read-only.
 *
 * Takes an INCREASE, not an absolute cap, and computes the new absolute
 * cap here from Meta's live spend_cap fetched in this same call — never
 * from a client-supplied absolute number. This closes two problems a
 * client-computed absolute value would have: (1) the money rule ("never
 * trust frontend-computed amounts") — a submitted absolute figure can't be
 * verified against anything; (2) a stale-baseline race — if the dialog was
 * opened a while ago, or another admin changed the cap in between, an
 * absolute value computed from what the dialog showed at open time would
 * silently overwrite that concurrent change. Building the new cap from the
 * fetch made *in this request* means it always adds on top of whatever the
 * live cap actually is at write time, same spirit as the limit-request
 * flow's stale-baseline detection (spec §30).
 *
 * Also blocks (before writing anything) if the computed new cap would fall
 * below current amount_spent — Meta would pause all delivery immediately.
 */
export const updateMetaSpendCapFn = createServerFn({ method: 'POST' })
  .validator(updateMetaSpendCapSchema)
  .handler(async ({ data }): Promise<AdAccount> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { before, externalAccountId, meta, account: linkedAccount } =
      await loadUsdLinkedAccount(admin, data.id, actor.organizationId, actor)
    const amountSpent = dec(meta.amount_spent ?? 0)
    const liveCap = meta.spend_cap != null ? dec(meta.spend_cap) : dec(0)
    const newCap = liveCap.plus(dec(data.increase_by_usd))
    if (newCap.lt(amountSpent)) {
      throw new Error(
        `New spend cap ($${newCap.toFixed(2)}) is below the $${amountSpent.toFixed(2)} already spent on this account — Meta would pause all delivery immediately. Choose a larger increase.`,
      )
    }

    // Write direction is asymmetric from read (see updateMetaAdAccountSpendCap
    // for the unit trap) — pass the major-unit dollar value straight through.
    await updateMetaAdAccountSpendCap(
      externalAccountId,
      newCap.toFixed(2),
      metaCredentialScopeFor(linkedAccount),
    )

    const { data: account, error } = await admin
      .from('ad_accounts')
      .update({ current_limit_usd: newCap.toFixed(2) })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'AD_ACCOUNT_UPDATED',
      entityType: 'AD_ACCOUNT',
      entityId: data.id,
      oldValues: {
        current_limit_usd: before.current_limit_usd,
        meta_spend_cap: meta.spend_cap,
      },
      newValues: {
        current_limit_usd: newCap.toFixed(2),
        meta_spend_cap: newCap.toFixed(2),
      },
      metadata: { source: 'META_SPEND_CAP_PUSH' },
    })
    return account as AdAccount
  })

/**
 * Manually retry pushing this account's current_limit_usd to Meta's
 * spend_cap, when the automatic post-approval push (see
 * spend-cap-sync.server.ts, triggered from approveLimitRequestFn) failed and
 * the account is flagged meta_sync_pending. Gives an admin an immediate
 * escape hatch instead of waiting for the daily retry cron. Reuses the same
 * best-effort sync path — never throws on a Meta-side failure; the returned
 * account row reflects whether meta_sync_pending cleared or is still set.
 */
export const retryMetaSpendCapSyncFn = createServerFn({ method: 'POST' })
  .validator(retryMetaSpendCapSyncSchema)
  .handler(async ({ data }): Promise<AdAccount> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    // Never trust that data.id belongs to the caller's own org — this is
    // the only entry point to syncAndPersistAdAccountSpendCap that's
    // user-reachable with an arbitrary id (the others come from an
    // already-org-validated context).
    const accessible = await loadAccessibleAdAccount(admin, data.id, actor.organizationId)
    if (!canMutateSpendCap(accessible as unknown as { is_platform: boolean }, actor)) {
      throw new Error(
        "This account's spend cap is managed by the platform — it was assigned to your agency, not connected through your own Meta credentials.",
      )
    }

    await syncAndPersistAdAccountSpendCap(data.id, {
      actorUserId: actor.id,
      source: 'META_SPEND_CAP_AUTO_SYNC',
    })

    const { data: account, error } = await admin
      .from('ad_accounts')
      .select('*')
      .eq('id', data.id)
      .single()
    if (error) throw new Error(error.message)
    return account as unknown as AdAccount
  })

// ===========================================================================
// Client
// ===========================================================================

export interface MyAccountRemaining {
  ad_account_id: string
  remaining: string | null
  meta_balance: string | null
  currency: string | null
}

/**
 * Remaining Meta spend headroom (spend_cap − amount_spent) and Meta Due
 * (balance owed to Meta) for the signed-in client's own actively-assigned
 * accounts — never anything beyond them. All other Meta fns in this file
 * are requireAdmin-gated and would leak the whole Business Portfolio if
 * reused directly; this reuses the same underlying bulk Graph API fetch
 * (still 2 calls total, not one per account) but the response never leaves
 * the server until it's been filtered down to only this client's own
 * external_account_ids.
 *
 * Display-only — no currency gate on the value itself (that's only needed
 * for the admin side's alert thresholds, which don't exist here);
 * formatCurrencyAmount renders any currency correctly client-side.
 */
export const listMyAccountsMetaRemainingFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Array<MyAccountRemaining>> => {
  const { user, membership } = await requireClientMembership()
  const admin = getSupabaseAdminClient()

  const { data: assignments, error } = await admin
    .from('ad_account_assignments')
    .select(
      'ad_account_id, account:ad_accounts(external_account_id, is_platform, organization_id)',
    )
    .eq('client_id', membership.clientId)
    .eq('status', 'ACTIVE')
  if (error) throw new Error(error.message)

  const rows = (assignments ?? []) as unknown as Array<{
    ad_account_id: string
    account: {
      external_account_id: string | null
      is_platform: boolean
      organization_id: string | null
    } | null
  }>
  const linkedRows = rows.filter((r) => r.account?.external_account_id)
  if (linkedRows.length === 0) return []

  // One client's accounts can span two Business Portfolios: ones their agency
  // connected itself, and platform-pool accounts granted to that agency. Each
  // set is fetched with its own credentials — a pool account is invisible to
  // the agency's own token. Usually only one set is in play, so this is one
  // bulk fetch in practice, never one call per account.
  const byExternalId = await fetchAcrossCredentialSets(
    linkedRows.map((r) => metaCredentialScopeFor(r.account!)),
  )
  if (byExternalId.size === 0) return []
  void user

  return linkedRows.map((r) => {
    const externalId = r.account!.external_account_id!
    const m = byExternalId.get(externalId)
    if (!m) {
      return {
        ad_account_id: r.ad_account_id,
        remaining: null,
        meta_balance: null,
        currency: null,
      }
    }
    const remaining =
      m.spend_cap != null
        ? dec(m.spend_cap).minus(dec(m.amount_spent ?? 0)).toFixed(2)
        : null
    return {
      ad_account_id: r.ad_account_id,
      remaining,
      meta_balance: m.meta_balance,
      currency: m.currency,
    }
  })
})
