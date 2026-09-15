import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { organizationId as organizationIdSchema } from '@/schemas/organization'
import { importPoolAccountsSchema } from '@/schemas/meta'
import { listMetaBusinessAdAccounts } from '@/server/meta/meta.server'
import type { MetaAdAccountSummary } from '@/server/meta/meta.server'
import { PLATFORM_CREDENTIALS } from '@/lib/meta/credential-scope'
import { DEPLOYMENT_ORGANIZATION_ID } from '@/lib/organizations/deployment-org'
import type { AdAccount } from '@/types/domain'

/**
 * The platform-owned ad account pool: accounts the vendor holds centrally and
 * grants to individual agencies. Every fn here is requirePlatformAdmin()-gated
 * — granting an account is a cross-tenant action no agency admin may take, and
 * assignment is push-only by design (agencies cannot browse or request pool
 * accounts; that was explicitly out of scope).
 *
 * "Grant" is used throughout rather than "assign": ad_account_assignments
 * already means ad account -> CLIENT. See the migration's naming note.
 */

export interface PoolAccountRow {
  account: AdAccount
  granted_to: { organization_id: string; name: string; granted_at: string } | null
}

const grantSchema = z.object({
  ad_account_id: z.uuid(),
  organization_id: organizationIdSchema,
})

/** Every pool account, with who currently holds it. */
export const listPoolAccountsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<PoolAccountRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: accounts, error } = await admin
      .from('ad_accounts')
      .select('*')
      .eq('is_platform', true)
      .order('account_code')
    if (error) throw new Error(error.message)

    const { data: grants, error: grantError } = await admin
      .from('platform_account_grants')
      .select(
        'ad_account_id, organization_id, granted_at, organization:organizations(name)',
      )
    if (grantError) throw new Error(grantError.message)

    const byAccount = new Map(
      (
        (grants ?? []) as unknown as Array<{
          ad_account_id: string
          organization_id: string
          granted_at: string
          organization: { name: string } | null
        }>
      ).map((g) => [
        g.ad_account_id,
        {
          organization_id: g.organization_id,
          name: g.organization?.name ?? '',
          granted_at: g.granted_at,
        },
      ]),
    )

    return ((accounts ?? []) as Array<AdAccount>).map((account) => ({
      account,
      granted_to: byAccount.get(account.id) ?? null,
    }))
  },
)

/**
 * Grant one pool account to one agency.
 *
 * The UNIQUE constraint on ad_account_id is the real guard against
 * double-granting; this checks first only so the admin gets a message naming
 * the agency that already holds it rather than a raw constraint error.
 */
export const grantPoolAccountFn = createServerFn({ method: 'POST' })
  .validator(grantSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: account } = await admin
      .from('ad_accounts')
      .select('id, account_code, name, is_platform')
      .eq('id', data.ad_account_id)
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
      .eq('id', data.organization_id)
      .maybeSingle()
    if (!org) throw new Error('Organization not found')

    const { data: existing } = await admin
      .from('platform_account_grants')
      .select('organization_id, organization:organizations(name)')
      .eq('ad_account_id', data.ad_account_id)
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
      ad_account_id: data.ad_account_id,
      organization_id: data.organization_id,
      granted_by: actor.id,
    })
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'PLATFORM_ACCOUNT_GRANTED',
      entityType: 'AD_ACCOUNT',
      entityId: data.ad_account_id,
      newValues: {
        account_code: (account as { account_code: string }).account_code,
        account_name: (account as { name: string }).name,
        organization_id: data.organization_id,
        organization_name: (org as { name: string }).name,
      },
    })
    return { ok: true }
  })

/**
 * Revoke a grant. The account stays in the pool; the agency loses access
 * immediately — including any of their clients currently holding it, since
 * every read now resolves through the owned-or-granted scope.
 */
export const revokePoolAccountFn = createServerFn({ method: 'POST' })
  .validator(z.object({ ad_account_id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: existing } = await admin
      .from('platform_account_grants')
      .select('organization_id, organization:organizations(name)')
      .eq('ad_account_id', data.ad_account_id)
      .maybeSingle()
    if (!existing) throw new Error('That account is not currently granted')

    const { error } = await admin
      .from('platform_account_grants')
      .delete()
      .eq('ad_account_id', data.ad_account_id)
    if (error) throw new Error(error.message)

    const row = existing as unknown as {
      organization_id: string
      organization: { name: string } | null
    }
    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'PLATFORM_ACCOUNT_REVOKED',
      entityType: 'AD_ACCOUNT',
      entityId: data.ad_account_id,
      oldValues: {
        organization_id: row.organization_id,
        organization_name: row.organization?.name ?? null,
      },
    })
    return { ok: true }
  })

// ---------------------------------------------------------------------------
// Importing accounts INTO the pool
// ---------------------------------------------------------------------------

export type PoolImportCandidate = MetaAdAccountSummary & {
  already_linked: boolean
  linked_account_code: string | null
}

/**
 * The platform's own Business Portfolio, annotated with what is already in the
 * pool.
 *
 * This is the platform-side counterpart of the agency's "Import from Meta", and
 * it exists because the credentials moved here (migration 000037). Before that,
 * the pool's portfolio was reachable as org zero's, so xRush's own admin screen
 * could import from it; once the platform owns those credentials, no agency
 * screen can see that portfolio at all, and without this the only way to add a
 * newly-created Meta account to the pool would be hand-written SQL.
 *
 * Deliberately not scoped to unlinked accounts only: showing the already-linked
 * ones greyed out is how an admin confirms the portfolio is the one they think
 * it is.
 */
export const listPoolImportCandidatesFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Array<PoolImportCandidate>> => {
  await requirePlatformAdmin()
  const metaAccounts = await listMetaBusinessAdAccounts(PLATFORM_CREDENTIALS)
  if (metaAccounts.length === 0) return []

  const admin = getSupabaseAdminClient()
  // Checked against EVERY ad_accounts row, not just pool ones: external_account_id
  // is globally unique (the partial index from migration 000011), so an account
  // an agency imported into its own books would collide on insert here. Better
  // to show it as already linked than to fail at the constraint.
  const { data: existing, error } = await admin
    .from('ad_accounts')
    .select('account_code, external_account_id')
    .in(
      'external_account_id',
      metaAccounts.map((a) => a.external_account_id),
    )
  if (error) throw new Error(error.message)
  const byExternalId = new Map(
    (existing ?? []).map((r) => [
      r.external_account_id as string,
      r.account_code as string,
    ]),
  )

  return metaAccounts.map((account) => ({
    ...account,
    already_linked: byExternalId.has(account.external_account_id),
    linked_account_code: byExternalId.get(account.external_account_id) ?? null,
  }))
})

/**
 * Bulk-creates POOL accounts (`is_platform: true`, `organization_id: null`)
 * from the platform's portfolio. Ungranted on creation — granting is a separate,
 * deliberate action per account.
 *
 * Mirrors importMetaAdAccountsFn's semantics otherwise: each row starts
 * AVAILABLE with current_limit_usd 0, because Meta's spend_cap is a different
 * concept from our operational limit baseline (spec §20) and is never
 * auto-mapped onto it. Re-checks already-linked ids immediately before
 * inserting, since the dialog's list can be stale by submit time; the unique
 * partial index on external_account_id is the hard backstop.
 */
export const importPoolAccountsFn = createServerFn({ method: 'POST' })
  .validator(importPoolAccountsSchema)
  .handler(async ({ data }): Promise<Array<AdAccount>> => {
    const actor = await requirePlatformAdmin()
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
        'All selected accounts are already linked — nothing new to add to the pool.',
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
          // 0 means "inherit", resolved against the holding client's own rate
          // when the account is eventually assigned — see rate.service.ts.
          usd_rate: 0,
          status: 'AVAILABLE' as const,
          is_platform: true,
          organization_id: null,
        })),
      )
      .select('*')
    if (error) throw new Error(error.message)

    for (const account of accounts ?? []) {
      await writeAudit({
        actorUserId: actor.id,
        // audit_logs.organization_id is NOT NULL and a pool account belongs to
        // no agency until it is granted, so these land in the platform's own
        // organization — the same fallback used elsewhere for ungranted pool
        // accounts.
        organizationId: actor.organizationId || DEPLOYMENT_ORGANIZATION_ID,
        action: 'AD_ACCOUNT_CREATED',
        entityType: 'AD_ACCOUNT',
        entityId: account.id,
        newValues: account,
        metadata: { source: 'PLATFORM_POOL_IMPORT' },
      })
    }
    return (accounts ?? []) as Array<AdAccount>
  })
