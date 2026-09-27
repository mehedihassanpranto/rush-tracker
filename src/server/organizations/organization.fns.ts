import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { DEPLOYMENT_ORGANIZATION_ID } from '@/lib/organizations/deployment-org'
import {
  organizationAdminCreateSchema,
  organizationAdminRefSchema,
  organizationAdminStatusSchema,
  organizationCreateSchema,
  organizationDeleteSchema,
  organizationIdSchema,
  organizationStatusSchema,
  organizationUpdateSchema,
} from '@/schemas/organization'
import type { Organization } from '@/types/domain'
// Typed from the package, NOT as ReturnType<typeof getSupabaseAdminClient>:
// a type alias referencing that binding keeps the `*.server` import alive
// after the handler bodies are stripped, and import protection fails the
// client build.
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Multi-tenant subscription conversion, Phase 2: the super-admin panel's
 * server layer. Every fn here is requirePlatformAdmin()-gated, not
 * requireAdmin() — this is the one place in the app that deliberately sees
 * and edits across every organization, not just the caller's own. `organizations`
 * itself has zero RLS policies for `authenticated` (see the Phase 1
 * migration's notes), so these fns are the only reachable path to it.
 */

/** Every organization, for the panel's list/search/filter (client-side —
 * this list is manually curated and small by design, not paginated). */
export const listOrganizationsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<Organization>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('organizations')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data as Array<Organization>
  },
)

/** One agency's profile: the record itself, how much of the product they're
 * using, and who to contact. */
export interface OrganizationProfile {
  organization: Organization
  counts: {
    clients: number
    adAccounts: number
    staff: number
    portalLogins: number
  }
  admins: Array<{
    user_id: string
    full_name: string
    email: string
    role: string
    status: string
    /** Platform operators are managed outside an agency's contact list —
     * the UI hides the destructive row actions for them. */
    is_platform_admin: boolean
  }>
}

/**
 * Profile for one agency. Deliberately aggregate-only: counts of what they
 * use and who administers them, never their actual clients, ledger or
 * account data. A platform admin manages subscriptions; they have no
 * business reading a customer's books, and every other server fn in the
 * app enforces that by filtering on the caller's own organization.
 */
export const getOrganizationFn = createServerFn({ method: 'GET' })
  .validator(organizationIdSchema)
  .handler(async ({ data }): Promise<OrganizationProfile> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: org, error } = await admin
      .from('organizations')
      .select('*')
      .eq('id', data.id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!org) throw new Error('Organization not found')

    const countIn = (table: string) =>
      admin
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', data.id)

    // Ad accounts are counted through the owned-or-granted union, not a plain
    // organization_id filter: a platform-pool account granted to this agency
    // has organization_id NULL, so the simple count under-reports it (it read
    // 0 for an agency holding 34 granted accounts).
    const { data: grantRows } = await admin
      .from('platform_account_grants')
      .select('ad_account_id')
      .eq('organization_id', data.id)
    const grantedIds = (grantRows ?? []).map((g) => g.ad_account_id as string)
    let accountCountQuery = admin
      .from('ad_accounts')
      .select('*', { count: 'exact', head: true })
    accountCountQuery =
      grantedIds.length > 0
        ? accountCountQuery.or(
            `organization_id.eq.${data.id},id.in.(${grantedIds.join(',')})`,
          )
        : accountCountQuery.eq('organization_id', data.id)

    const [clients, adAccounts, memberships, profiles] = await Promise.all([
      countIn('clients'),
      accountCountQuery,
      admin
        .from('client_memberships')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', data.id)
        .eq('status', 'ACTIVE'),
      admin
        .from('user_profiles')
        .select('user_id, full_name, status, is_platform_admin, role:roles(key)')
        .eq('organization_id', data.id),
    ])

    const allProfiles = (profiles.data ?? []) as unknown as Array<{
      user_id: string
      full_name: string
      status: string
      is_platform_admin: boolean | null
      role: { key: string } | null
    }>
    const staffProfiles = allProfiles.filter(
      (p) => p.role?.key === 'ADMIN' || p.role?.key === 'SUPER_ADMIN',
    )

    // Emails live in auth.users; a handful of staff per agency, so one
    // lookup each is fine here (same approach as listClientUsersFn).
    const admins: OrganizationProfile['admins'] = []
    for (const p of staffProfiles) {
      const { data: userRes } = await admin.auth.admin.getUserById(p.user_id)
      admins.push({
        user_id: p.user_id,
        full_name: p.full_name,
        email: userRes.user?.email ?? '',
        role: p.role?.key ?? '',
        status: p.status,
        is_platform_admin: p.is_platform_admin ?? false,
      })
    }

    return {
      organization: org as Organization,
      counts: {
        clients: clients.count ?? 0,
        adAccounts: adAccounts.count ?? 0,
        staff: staffProfiles.length,
        portalLogins: memberships.count ?? 0,
      },
      admins,
    }
  })

/** Refuse before anything is created: createUser() would fail on a duplicate
 * anyway, but only after the caller had already built something to roll back. */
async function assertEmailAvailable(admin: SupabaseClient, email: string) {
  const { data: existing, error } = await admin.rpc('find_auth_user_by_email', {
    p_email: email,
  })
  if (error) throw new Error(error.message)
  if (existing?.[0]) {
    throw new Error(
      'That email already has an account. Use a different address for this agency’s admin.',
    )
  }
}

/**
 * Create one SUPER_ADMIN login inside an organization, and return its user id.
 *
 * The two fields set on the profile here are exactly what `handle_new_user()`
 * gets wrong for this case: the trigger lands every new account in org zero
 * with the CLIENT role, so an admin created without them is both in the wrong
 * agency and unable to administer anything. Never `is_platform_admin` — this
 * person owns an agency, not the platform.
 *
 * Cleans up its own half-created auth user if the profile update fails (the
 * auth API and Postgres aren't one transaction). Anything the caller created
 * beforehand is the caller's to roll back.
 */
async function provisionOrganizationSuperAdmin(
  admin: SupabaseClient,
  input: {
    organizationId: string
    fullName: string
    email: string
    password: string
  },
): Promise<string> {
  const { data: roleRow } = await admin
    .from('roles')
    .select('id')
    .eq('key', 'SUPER_ADMIN')
    .single()
  if (!roleRow) throw new Error('SUPER_ADMIN role is missing')

  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    app_metadata: { app_role: 'SUPER_ADMIN' },
    user_metadata: { full_name: input.fullName },
  })
  if (userError) throw new Error(userError.message)
  const userId = created.user.id

  const { error: profileError } = await admin
    .from('user_profiles')
    .update({
      full_name: input.fullName,
      organization_id: input.organizationId,
      role_id: (roleRow as { id: string }).id,
    })
    .eq('user_id', userId)
  if (profileError) {
    await admin.auth.admin.deleteUser(userId)
    throw new Error(profileError.message)
  }
  return userId
}

/**
 * Onboard a new subscribing agency: creates the organization AND its first
 * SUPER_ADMIN login in one step. Doing these separately is what previously
 * required hand-written SQL — and getting only half of it done leaves
 * either an organization nobody can log into, or an admin sitting in org
 * zero (the handle_new_user trigger defaults every new account to org zero
 * with the CLIENT role, so both fields must be set explicitly here).
 *
 * Not transactional across Postgres and the auth API — they're separate
 * systems — so anything that fails after the organization row exists rolls
 * it back by hand, rather than leaving an orphan behind.
 */
export const createOrganizationFn = createServerFn({ method: 'POST' })
  .validator(organizationCreateSchema)
  .handler(
    async ({ data }): Promise<{ organization: Organization; user_id: string }> => {
      const actor = await requirePlatformAdmin()
      const admin = getSupabaseAdminClient()

      await assertEmailAvailable(admin, data.admin_email)

      const { data: org, error: orgError } = await admin
        .from('organizations')
        .insert({
          name: data.name,
          plan: data.plan ?? null,
          notes: data.notes ?? null,
          subscription_status: 'active',
        })
        .select('*')
        .single()
      if (orgError) throw new Error(orgError.message)

      let userId: string
      try {
        userId = await provisionOrganizationSuperAdmin(admin, {
          organizationId: (org as Organization).id,
          fullName: data.admin_full_name,
          email: data.admin_email,
          password: data.admin_password,
        })
      } catch (err) {
        // The helper cleans up its own auth user; the organization row is
        // ours, and an agency nobody can sign into is worse than none.
        await admin.from('organizations').delete().eq('id', (org as Organization).id)
        throw err instanceof Error
          ? err
          : new Error('Failed to create the organization')
      }

      await writeAudit({
        actorUserId: actor.id,
        organizationId: actor.organizationId,
        action: 'ORGANIZATION_CREATED',
        entityType: 'ORGANIZATION',
        entityId: (org as Organization).id,
        newValues: {
          name: data.name,
          plan: data.plan ?? null,
          admin_email: data.admin_email,
          admin_user_id: userId,
        },
      })
      return { organization: org as Organization, user_id: userId }
    },
  )

/**
 * Add a Super Admin login to an organization that already exists — the only
 * way back in for an agency with no working admin account, which otherwise
 * needed hand-written SQL exactly like onboarding did before createOrganizationFn.
 *
 * This is a real privilege: the login it creates can see that agency's own
 * clients and ledger, which no platform-admin screen can. It's deliberately
 * not restricted to agencies with zero admins (an agency whose only admin is
 * locked out still has a row, and would be stranded), so the audit trail is
 * what makes it accountable — ORGANIZATION_ADMIN_CREATED names the platform
 * admin who did it, the agency, and the email that was granted access.
 */
export const createOrganizationAdminFn = createServerFn({ method: 'POST' })
  .validator(organizationAdminCreateSchema)
  .handler(async ({ data }): Promise<{ user_id: string }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: org } = await admin
      .from('organizations')
      .select('id, name')
      .eq('id', data.organization_id)
      .maybeSingle()
    if (!org) throw new Error('Organization not found')

    await assertEmailAvailable(admin, data.email)

    const userId = await provisionOrganizationSuperAdmin(admin, {
      organizationId: data.organization_id,
      fullName: data.full_name,
      email: data.email,
      password: data.password,
    })

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'ORGANIZATION_ADMIN_CREATED',
      entityType: 'ORGANIZATION',
      entityId: data.organization_id,
      newValues: {
        organization_name: (org as { name: string }).name,
        admin_email: data.email,
        admin_full_name: data.full_name,
        admin_user_id: userId,
        role: 'SUPER_ADMIN',
      },
    })
    return { user_id: userId }
  })

/**
 * Load one agency admin, scoped to the (organization, user) pair rather than
 * the user id alone — the same double-`.eq()` discipline the client-membership
 * fns use, so a request naming the wrong agency matches nothing instead of
 * acting on someone else's admin.
 *
 * Refuses platform operators outright: those accounts appear in their own
 * agency's contact list, but revoking the platform's access is not something
 * an agency's contact card should be able to do by accident.
 */
async function loadOrganizationAdmin(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
) {
  const { data: profile } = await admin
    .from('user_profiles')
    .select('user_id, full_name, status, is_platform_admin, role:roles(key)')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (!profile) throw new Error('Admin not found')

  const row = profile as unknown as {
    user_id: string
    full_name: string
    status: string
    is_platform_admin: boolean | null
    role: { key: string } | null
  }
  if (row.is_platform_admin) {
    throw new Error(
      'That account is a platform operator — manage it from the platform accounts, not an agency’s contact list.',
    )
  }
  if (row.role?.key !== 'ADMIN' && row.role?.key !== 'SUPER_ADMIN') {
    throw new Error('That account is not an admin of this agency')
  }
  return row
}

/**
 * Revoke (or restore) an agency admin's access without destroying anything.
 * This is the action to reach for in almost every case: an inactive profile
 * fails `loadSessionUser()`, so they can't sign in, while every record they
 * ever approved keeps pointing at a real account.
 */
export const setOrganizationAdminStatusFn = createServerFn({ method: 'POST' })
  .validator(organizationAdminStatusSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    if (data.user_id === actor.id) {
      throw new Error('You cannot change your own status')
    }
    const admin = getSupabaseAdminClient()
    const target = await loadOrganizationAdmin(
      admin,
      data.organization_id,
      data.user_id,
    )

    const { error } = await admin
      .from('user_profiles')
      .update({ status: data.status })
      .eq('user_id', data.user_id)
      .eq('organization_id', data.organization_id)
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'ORGANIZATION_ADMIN_STATUS_CHANGED',
      entityType: 'ORGANIZATION',
      entityId: data.organization_id,
      oldValues: { status: target.status },
      newValues: {
        status: data.status,
        admin_user_id: data.user_id,
        admin_full_name: target.full_name,
      },
    })
    return { ok: true }
  })

/**
 * Permanently delete an agency admin's login.
 *
 * Only safe for an account that has never done anything — which is the case
 * worth supporting (an admin added by mistake, or a duplicate). Every FK to
 * `auth.users` in this schema (`reviewed_by`, `created_by`, `assigned_by`,
 * `actor_user_id`, …) was declared with no ON DELETE clause, so Postgres
 * itself refuses to delete an account that approved a limit request, verified
 * a payment, or wrote an audit row — deliberately, since those records must
 * keep naming a real person. Rather than let that surface as a raw database
 * error, the audit trail is checked first (every write path in this app
 * records one) and the caller is pointed at deactivation instead; the FK
 * error is still translated if something outside the audit trail holds a
 * reference.
 *
 * Deleting the agency's last admin is NOT blocked — removing an agency added
 * by mistake is legitimate, and since createOrganizationAdminFn exists it is
 * no longer a one-way door. The dialog warns when that's the case.
 */
export const deleteOrganizationAdminFn = createServerFn({ method: 'POST' })
  .validator(organizationAdminRefSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    if (data.user_id === actor.id) {
      throw new Error('You cannot delete your own account')
    }
    const admin = getSupabaseAdminClient()
    const target = await loadOrganizationAdmin(
      admin,
      data.organization_id,
      data.user_id,
    )

    const { count: activityCount } = await admin
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .eq('actor_user_id', data.user_id)
    if (activityCount) {
      throw new Error(
        `${target.full_name} has ${activityCount} recorded action${
          activityCount === 1 ? '' : 's'
        } in this agency, so their login can't be deleted — the records naming them must keep pointing at a real account. Deactivate them instead to revoke access.`,
      )
    }

    // Cascades user_profiles and notifications; every other reference would
    // have been caught above, and is refused by the database if not.
    const { error } = await admin.auth.admin.deleteUser(data.user_id)
    if (error) {
      throw new Error(
        `Could not delete ${target.full_name}: their account is still referenced by records that must not be destroyed. Deactivate them instead. (${error.message})`,
      )
    }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'ORGANIZATION_ADMIN_DELETED',
      entityType: 'ORGANIZATION',
      entityId: data.organization_id,
      oldValues: {
        admin_user_id: data.user_id,
        admin_full_name: target.full_name,
        role: target.role?.key ?? null,
      },
    })
    return { ok: true }
  })

/** Edit name/plan/notes — everything except subscription_status, which has
 * its own dedicated fn below (mirrors clients: updateClientFn vs.
 * setClientStatusFn) so a plain status toggle stays a single, clearly
 * audited action distinct from a general edit. */
export const updateOrganizationFn = createServerFn({ method: 'POST' })
  .validator(organizationUpdateSchema)
  .handler(async ({ data }): Promise<Organization> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: before } = await admin
      .from('organizations')
      .select('*')
      .eq('id', data.id)
      .single()
    if (!before) throw new Error('Organization not found')

    const { data: org, error } = await admin
      .from('organizations')
      .update({
        name: data.name,
        plan: data.plan ?? null,
        notes: data.notes ?? null,
      })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'ORGANIZATION_UPDATED',
      entityType: 'ORGANIZATION',
      entityId: data.id,
      oldValues: before,
      newValues: org,
    })
    return org as Organization
  })

/**
 * Activate/suspend — the panel's main action. Setting 'suspended' also
 * stamps suspended_at; reactivating clears it. A platform admin can never
 * suspend their OWN organization through this screen: they'd personally
 * still bypass the subscription gate either way (guards.server.ts), but
 * every OTHER real user in that organization would be locked out — a
 * realistic one-click mistake this blocks rather than a defense against
 * anything adversarial.
 */
export const updateOrganizationSubscriptionStatusFn = createServerFn({
  method: 'POST',
})
  .validator(organizationStatusSchema)
  .handler(async ({ data }): Promise<Organization> => {
    const actor = await requirePlatformAdmin()
    if (data.id === actor.organizationId && data.subscription_status !== 'active') {
      throw new Error('You cannot suspend your own organization')
    }
    const admin = getSupabaseAdminClient()

    const { data: before } = await admin
      .from('organizations')
      .select('subscription_status')
      .eq('id', data.id)
      .single()
    if (!before) throw new Error('Organization not found')

    const { data: org, error } = await admin
      .from('organizations')
      .update({
        subscription_status: data.subscription_status,
        suspended_at:
          data.subscription_status === 'suspended' ? new Date().toISOString() : null,
      })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'ORGANIZATION_SUBSCRIPTION_STATUS_CHANGED',
      entityType: 'ORGANIZATION',
      entityId: data.id,
      oldValues: {
        subscription_status: (before as { subscription_status: string })
          .subscription_status,
      },
      newValues: { subscription_status: data.subscription_status },
    })
    return org as Organization
  })

/**
 * Tables holding one agency's data, in FK-safe deletion order.
 *
 * Deliberately a SUPERSET of maintenance.fns.ts's WIPE_ORDER: that one clears
 * business data but keeps the agency running (admin logins, rates, finance
 * records survive). Offboarding removes the agency entirely, so it also takes
 * exchange_rates, usd_margin_entries and finally user_profiles.
 *
 * Every one of the 17 multi-tenant tables references organizations(id) with no
 * ON DELETE clause, so the organization row cannot be removed until these are
 * gone — Postgres enforces the order, this list just satisfies it.
 *
 * NOT listed, on purpose: platform-pool ad accounts. They have
 * organization_id NULL, so the ad_accounts delete never matches them — a
 * customer leaving must not destroy accounts the platform owns. Their grants
 * are removed by the ON DELETE CASCADE on platform_account_grants, returning
 * the accounts to the pool unassigned.
 *
 * ALSO NOT listed, on purpose: usd_sales (the platform's USD stock ledger,
 * migration 000041). A sale is the PLATFORM's revenue, and total_usd_sold feeds
 * remaining stock — deleting a departed customer's rows would put phantom
 * dollars back into stock. Its organization_id is ON DELETE SET NULL, so the
 * organization row deletes cleanly and the sale survives under the agency_name
 * it was recorded with. Do not add it here for "completeness".
 */
const OFFBOARD_ORDER = [
  'notifications',
  'audit_logs',
  'adjustments',
  'ledger_entries',
  'payments',
  'payment_requests',
  'limit_requests',
  // requested_by is a NO ACTION FK to auth.users, so these must go before the
  // agency's logins do (cascading from the organization row is too late).
  'platform_account_requests',
  'ad_account_assignments',
  'attachments',
  'ad_accounts',
  // Still listed after the Employees feature was removed (2026-09-15): the
  // tables and their FK to organizations remain, so the organization row
  // cannot be deleted until they are cleared.
  'client_employees',
  'employees',
  'client_memberships',
  'clients',
  'exchange_rates',
  'usd_margin_entries',
  'user_profiles',
] as const

/**
 * Permanently delete an agency and everything belonging to it.
 *
 * This is the most destructive action in the application and it is guarded
 * accordingly:
 *  - never your own organization, and never the deployment's own (org zero) —
 *    that one owns the platform pool's credentials and the platform admins;
 *  - the subscription must already be `cancelled`, so deleting is a deliberate
 *    second step rather than one click away from a paying customer;
 *  - the caller must retype the agency's exact name.
 *
 * The audit row is written BEFORE the deletion, and lands in the acting
 * platform admin's own organization — so the record of the offboarding
 * survives the agency it describes.
 */
export const deleteOrganizationFn = createServerFn({ method: 'POST' })
  .validator(organizationDeleteSchema)
  .handler(async ({ data }): Promise<{ ok: true; deleted_logins: number }> => {
    const actor = await requirePlatformAdmin()
    if (data.id === actor.organizationId) {
      throw new Error('You cannot delete your own organization')
    }
    if (data.id === DEPLOYMENT_ORGANIZATION_ID) {
      throw new Error(
        'This is the platform’s own organization — it owns the account pool and platform logins, and cannot be deleted.',
      )
    }
    const admin = getSupabaseAdminClient()

    const { data: org } = await admin
      .from('organizations')
      .select('*')
      .eq('id', data.id)
      .maybeSingle()
    if (!org) throw new Error('Organization not found')
    const organization = org as Organization

    if (organization.subscription_status !== 'cancelled') {
      throw new Error(
        'Set this agency to Cancelled before deleting it — deleting an active or suspended subscription is not something to do in one step.',
      )
    }
    if (data.confirm_name.trim() !== organization.name) {
      throw new Error('The name you typed does not match this agency’s name')
    }

    // Written first: once the agency's rows are gone there is nothing left to
    // describe it, and this row belongs to the platform admin's organization
    // so it is not itself caught by the deletion below.
    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'ORGANIZATION_DELETED',
      entityType: 'ORGANIZATION',
      entityId: data.id,
      oldValues: organization as unknown as Record<string, unknown>,
    })

    // Collect the logins before their profiles are deleted — user_profiles is
    // the only link from an organization to its auth users.
    const { data: profiles } = await admin
      .from('user_profiles')
      .select('user_id')
      .eq('organization_id', data.id)
    const loginIds = (profiles ?? []).map((p) => p.user_id as string)

    for (const table of OFFBOARD_ORDER) {
      const { error } = await admin
        .from(table)
        .delete()
        .eq('organization_id', data.id)
      if (error) {
        throw new Error(`Failed clearing ${table}: ${error.message}`)
      }
    }

    // Auth users last: deleting one cascades its (already-removed) profile, and
    // every other FK to auth.users in this schema is NO ACTION — those rows
    // were just deleted above, so the users are now free to remove.
    let deleted = 0
    for (const userId of loginIds) {
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) {
        console.error('[offboard] failed to delete login', userId, error.message)
        continue
      }
      deleted++
    }

    const { error: orgError } = await admin
      .from('organizations')
      .delete()
      .eq('id', data.id)
    if (orgError) throw new Error(orgError.message)

    return { ok: true, deleted_logins: deleted }
  })

/**
 * Support view: one agency's ACTUAL clients, ad accounts and ledger.
 *
 * This is the one place a platform admin can read a customer's books, and it
 * exists because the capability already did — the RLS policies from the
 * multi-tenant migration end with `or is_platform_admin()`, so a platform
 * session could read every agency's rows straight from PostgREST. Leaving that
 * reachable but undocumented was the worst of both worlds: the power existed
 * and nothing recorded its use. Surfacing it deliberately makes it auditable.
 *
 * Two properties hold it honest:
 *  - **Read-only.** Nothing here writes to an agency's data. A platform admin
 *    looking at a customer's ledger is support; editing it is not, and would
 *    need its own deliberate design.
 *  - **The audit row is written into the VIEWED AGENCY'S organization**, not
 *    the platform's, so it appears in that agency's own Audit Log alongside
 *    their staff's actions. The customer can see when the vendor opened their
 *    books. (The audit screen's actor-name lookup is not org-scoped, so the
 *    platform admin's name resolves there correctly.)
 * The audit write happens BEFORE the data is returned, so an access is
 * recorded even if the page never finishes rendering.
 */
export interface AgencySupportData {
  organization: Organization
  clients: Array<{
    id: string
    client_code: string
    name: string
    status: string
    current_due: string
  }>
  adAccounts: Array<{
    id: string
    account_code: string
    name: string
    status: string
    current_limit_usd: string
    is_platform: boolean
  }>
  ledger: Array<{
    id: string
    transaction_number: string
    created_at: string
    type: string
    debit_bdt: string
    credit_bdt: string
    description: string | null
    client_name: string | null
  }>
}

export const getAgencySupportDataFn = createServerFn({ method: 'GET' })
  .validator(organizationIdSchema)
  .handler(async ({ data }): Promise<AgencySupportData> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: org } = await admin
      .from('organizations')
      .select('*')
      .eq('id', data.id)
      .maybeSingle()
    if (!org) throw new Error('Organization not found')
    const organization = org as Organization

    // Recorded first, and in the customer's own organization — see above.
    await writeAudit({
      actorUserId: actor.id,
      organizationId: data.id,
      action: 'PLATFORM_AGENCY_DATA_VIEWED',
      entityType: 'ORGANIZATION',
      entityId: data.id,
      metadata: {
        viewed_by_platform_admin: actor.id,
        organization_name: organization.name,
      },
    })

    const [clientsRes, accountsRes, ledgerRes, duesRes] = await Promise.all([
      admin
        .from('clients')
        .select('id, client_code, name, status')
        .eq('organization_id', data.id)
        .order('client_code'),
      // Owned accounts plus pool accounts granted to them — the same union the
      // agency itself sees, so the support view matches their screen.
      admin
        .from('platform_account_grants')
        .select('ad_account_id')
        .eq('organization_id', data.id),
      admin
        .from('ledger_entries')
        .select(
          'id, transaction_number, created_at, type, debit_bdt, credit_bdt, description, client_id',
        )
        .eq('organization_id', data.id)
        .order('created_at', { ascending: false })
        .limit(100),
      admin.rpc('all_client_dues', { p_organization_id: data.id }),
    ])

    const grantedIds = (accountsRes.data ?? []).map(
      (g) => g.ad_account_id as string,
    )
    let accountQuery = admin
      .from('ad_accounts')
      .select('id, account_code, name, status, current_limit_usd, is_platform')
      .order('account_code')
    accountQuery =
      grantedIds.length > 0
        ? accountQuery.or(
            `organization_id.eq.${data.id},id.in.(${grantedIds.join(',')})`,
          )
        : accountQuery.eq('organization_id', data.id)
    const { data: accounts } = await accountQuery

    const dueByClient = new Map<string, string>()
    for (const row of (duesRes.data ?? []) as Array<{
      client_id: string
      current_due: string | number
    }>) {
      dueByClient.set(row.client_id, String(row.current_due))
    }

    const clientRows = (clientsRes.data ?? []) as Array<{
      id: string
      client_code: string
      name: string
      status: string
    }>
    const nameByClient = new Map(clientRows.map((c) => [c.id, c.name]))

    return {
      organization,
      clients: clientRows.map((c) => ({
        ...c,
        current_due: dueByClient.get(c.id) ?? '0',
      })),
      adAccounts: (accounts ?? []) as AgencySupportData['adAccounts'],
      ledger: (
        (ledgerRes.data ?? []) as Array<
          Omit<AgencySupportData['ledger'][number], 'client_name'> & {
            client_id: string
          }
        >
      ).map((l) => ({
        id: l.id,
        transaction_number: l.transaction_number,
        created_at: l.created_at,
        type: l.type,
        debit_bdt: l.debit_bdt,
        credit_bdt: l.credit_bdt,
        description: l.description,
        client_name: nameByClient.get(l.client_id) ?? null,
      })),
    }
  })
