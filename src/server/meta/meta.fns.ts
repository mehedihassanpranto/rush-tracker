import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { dec } from '@/lib/money/money'
import {
  applyMetaSpendCapSchema,
  fetchMetaAdAccountSchema,
  importMetaAdAccountsSchema,
  updateMetaSpendCapSchema,
} from '@/schemas/meta'
import {
  fetchMetaAdAccount,
  listMetaBusinessAdAccounts,
  updateMetaAdAccountSpendCap,
} from '@/server/meta/meta.server'
import type { MetaAdAccountSummary } from '@/server/meta/meta.server'
import type { AdAccount } from '@/types/domain'

export type MetaImportCandidate = MetaAdAccountSummary & {
  already_linked: boolean
  linked_account_id: string | null
  linked_account_code: string | null
}

/** Fetch one Meta ad account's live details by account id — verify/prefill
 * use on the create form and the account detail page. Read-only. */
export const fetchMetaAdAccountFn = createServerFn({ method: 'POST' })
  .validator(fetchMetaAdAccountSchema)
  .handler(async ({ data }): Promise<MetaAdAccountSummary> => {
    await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    return fetchMetaAdAccount(data.external_account_id)
  })

/** List every ad account in the connected Business Portfolio, annotated with
 * whether it's already linked to an ad_accounts row here. */
export const listMetaBusinessAdAccountsFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Array<MetaImportCandidate>> => {
  await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
  const metaAccounts = await listMetaBusinessAdAccounts()

  const admin = getSupabaseAdminClient()
  const { data: linked, error } = await admin
    .from('ad_accounts')
    .select('id, account_code, external_account_id')
    .in(
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
 * limit-request flow after import. */
export const importMetaAdAccountsFn = createServerFn({ method: 'POST' })
  .validator(importMetaAdAccountsSchema)
  .handler(async ({ data }): Promise<Array<AdAccount>> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: accounts, error } = await admin
      .from('ad_accounts')
      .insert(
        data.accounts.map((a) => ({
          name: a.name,
          external_account_id: a.external_account_id,
          platform: 'META',
          current_limit_usd: 0,
          usd_rate: data.usd_rate,
          status: 'AVAILABLE' as const,
        })),
      )
      .select('*')

    if (error) throw new Error(error.message)

    for (const account of accounts ?? []) {
      await writeAudit({
        actorUserId: actor.id,
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

    const { data: before, error: fetchError } = await admin
      .from('ad_accounts')
      .select('*')
      .eq('id', data.id)
      .single()
    if (fetchError) throw new Error(fetchError.message)
    if (!before.external_account_id) {
      throw new Error('This account has no linked Meta external ID')
    }

    const meta = await fetchMetaAdAccount(before.external_account_id)
    if (meta.currency !== 'USD') {
      throw new Error(
        `Meta reports this account's currency as ${meta.currency ?? 'unknown'}, not USD — apply the limit manually`,
      )
    }
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
 * everything else here is read-only. Re-fetches live Meta data server-side
 * first (never trusts a client-supplied amount_spent) to enforce two
 * guards before writing anything:
 *   - USD only (no FX conversion path here, same gate as applyMetaSpendCapFn)
 *   - new cap must be >= current amount_spent, or Meta would immediately
 *     pause all delivery on the account — blocked here rather than letting
 *     an admin accidentally do that from a confirm dialog.
 */
export const updateMetaSpendCapFn = createServerFn({ method: 'POST' })
  .validator(updateMetaSpendCapSchema)
  .handler(async ({ data }): Promise<AdAccount> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: before, error: fetchError } = await admin
      .from('ad_accounts')
      .select('*')
      .eq('id', data.id)
      .single()
    if (fetchError) throw new Error(fetchError.message)
    if (!before.external_account_id) {
      throw new Error('This account has no linked Meta external ID')
    }

    const meta = await fetchMetaAdAccount(before.external_account_id)
    if (meta.currency !== 'USD') {
      throw new Error(
        `Meta reports this account's currency as ${meta.currency ?? 'unknown'}, not USD — this app can't push a limit to a non-USD account`,
      )
    }
    const amountSpent = dec(meta.amount_spent ?? 0)
    const newCap = dec(data.spend_cap_usd)
    if (newCap.lt(amountSpent)) {
      throw new Error(
        `New spend cap ($${newCap.toFixed(2)}) is below the $${amountSpent.toFixed(2)} already spent on this account — Meta would pause all delivery immediately. Choose a higher amount.`,
      )
    }

    // Write direction is asymmetric from read (see updateMetaAdAccountSpendCap
    // for the unit trap) — pass the major-unit dollar value straight through.
    await updateMetaAdAccountSpendCap(before.external_account_id, newCap.toFixed(2))

    const { data: account, error } = await admin
      .from('ad_accounts')
      .update({ current_limit_usd: newCap.toFixed(2) })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
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
