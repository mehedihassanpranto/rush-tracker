import type { SupabaseClient } from '@supabase/supabase-js'
import {
  checkPlanLimit,
  planLimit,
  planLimitMessage,
} from '@/lib/subscription/plans'
import type {
  OrganizationUsage,
  PlanLimitKind,
  SubscriptionPlan,
} from '@/lib/subscription/plans'

/**
 * Plan-limit enforcement, shared by every write that adds an active client, an
 * ad account or an active staff login to an agency.
 *
 * A plain service module with the admin client passed in, like
 * pool-grant.service.ts: several .fns.ts files call it, and exporting a helper
 * from one .fns.ts into another defeats the bundler's proof that it's
 * server-only.
 *
 * What counts (kept in one place so the profile page, the agency's own plan
 * card and enforcement can never disagree):
 * - clients: status ACTIVE
 * - ad accounts: owned outright + granted from the platform pool, any status
 * - staff: ADMIN / SUPER_ADMIN profiles with status ACTIVE, excluding platform
 *   operators (they administer the platform, not the agency)
 *
 * Known, accepted limitation: the check and the insert aren't one transaction,
 * so two admins adding at the same instant could land one over. These are
 * usage quotas, not money — an occasional +1 is harmless, and the agency simply
 * can't add more until it's back under.
 */

export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanLimitError'
  }
}

export async function getOrganizationPlan(
  admin: SupabaseClient,
  organizationId: string,
): Promise<SubscriptionPlan | null> {
  const { data, error } = await admin
    .from('organizations')
    .select('plan:subscription_plans(*)')
    .eq('id', organizationId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return ((data as unknown as { plan: SubscriptionPlan | null } | null)?.plan ?? null)
}

export async function getOrganizationUsage(
  admin: SupabaseClient,
  organizationId: string,
): Promise<OrganizationUsage> {
  const [clients, owned, granted, staff] = await Promise.all([
    admin
      .from('clients')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'ACTIVE'),
    admin
      .from('ad_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId),
    admin
      .from('platform_account_grants')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId),
    admin
      .from('user_profiles')
      .select('user_id, role:roles!inner(key)')
      .eq('organization_id', organizationId)
      .eq('status', 'ACTIVE')
      .eq('is_platform_admin', false)
      .in('roles.key', ['ADMIN', 'SUPER_ADMIN']),
  ])
  for (const r of [clients, owned, granted, staff]) {
    if (r.error) throw new Error(r.error.message)
  }
  return {
    clients: clients.count ?? 0,
    // A pool account is either granted (organization_id NULL) or owned, never
    // both (ad_accounts_ownership_ck), so the two counts don't overlap.
    adAccounts: (owned.count ?? 0) + (granted.count ?? 0),
    staff: (staff.data ?? []).length,
  }
}

/**
 * Throws PlanLimitError with a message naming the plan, its limit and the
 * current usage when adding `adding` more of `kind` would exceed the agency's
 * plan. No plan (or an unlimited limit) always passes.
 */
export async function assertPlanAllows(
  admin: SupabaseClient,
  organizationId: string,
  kind: PlanLimitKind,
  adding = 1,
): Promise<void> {
  if (adding <= 0) return
  const plan = await getOrganizationPlan(admin, organizationId)
  const limit = planLimit(plan, kind)
  if (limit === null || !plan) return
  const usage = await getOrganizationUsage(admin, organizationId)
  const result = checkPlanLimit(usage[kind], adding, limit)
  if (!result.ok) {
    throw new PlanLimitError(
      planLimitMessage(kind, plan.name, result.used, result.limit, adding),
    )
  }
}
