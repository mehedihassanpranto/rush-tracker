import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import {
  getOrganizationPlan,
  getOrganizationUsage,
} from '@/server/subscription/plan-limits.service'
import {
  billingStatus,
  dhakaToday,
  paidThroughFrom,
} from '@/lib/subscription/plans'
import type {
  BillingStatus,
  OrganizationUsage,
  SubscriptionPlan,
} from '@/lib/subscription/plans'

export interface MySubscription {
  plan: SubscriptionPlan | null
  usage: OrganizationUsage
  paid_through: string | null
  billing_status: BillingStatus
}

/**
 * An agency's own plan, usage against its limits, and paid-through date —
 * read-only, so the agency can see why an add was refused before it happens.
 * Any agency admin may read it (it's about their own organization); nothing
 * here can change a plan. Always scoped to the caller's own organization.
 */
export const getMySubscriptionFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MySubscription> => {
    const actor = await requireAdmin()
    const admin = getSupabaseAdminClient()
    const orgId = actor.organizationId

    const [plan, usage, org, payments] = await Promise.all([
      getOrganizationPlan(admin, orgId),
      getOrganizationUsage(admin, orgId),
      admin.from('organizations').select('billing_exempt').eq('id', orgId).maybeSingle(),
      admin.from('subscription_payments').select('period_end').eq('organization_id', orgId),
    ])
    if (payments.error) throw new Error(payments.error.message)

    const paidThrough = paidThroughFrom(
      (payments.data ?? []) as Array<{ period_end: string }>,
    )
    return {
      plan: plan ? { ...plan, monthly_fee_bdt: String(plan.monthly_fee_bdt) } : null,
      usage,
      paid_through: paidThrough,
      billing_status: billingStatus({
        billingExempt: (org.data as { billing_exempt: boolean } | null)?.billing_exempt ?? false,
        planFeeBdt: plan ? plan.monthly_fee_bdt : null,
        paidThrough,
        today: dhakaToday(),
      }),
    }
  },
)
