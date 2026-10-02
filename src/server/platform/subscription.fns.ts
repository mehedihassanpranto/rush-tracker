import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
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
import {
  planUpsertSchema,
  recordSubscriptionPaymentSchema,
  setOrganizationPlanSchema,
  subscriptionOrgSchema,
} from '@/schemas/subscription'

/**
 * Subscriptions v1, platform side: manage plans, put agencies on them, and
 * record what agencies pay. All requirePlatformAdmin. The tables have zero RLS
 * policies, so these fns (and the agency's read-only getMySubscriptionFn) are
 * the only way to reach them.
 *
 * Writes about one agency are audited into THAT agency's organization (same
 * transparency rule as the platform's other agency-facing actions): the agency
 * sees in its own audit log when the platform changed its plan or recorded a
 * payment. Plan edits aren't about any one agency and land in the platform
 * admin's own organization.
 */

export interface PlanWithUsage extends SubscriptionPlan {
  agency_count: number
}

export const listPlansFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<PlanWithUsage>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const [plans, orgs] = await Promise.all([
      admin.from('subscription_plans').select('*').order('sort_order').order('name'),
      admin.from('organizations').select('plan_id'),
    ])
    if (plans.error) throw new Error(plans.error.message)
    if (orgs.error) throw new Error(orgs.error.message)
    const counts = new Map<string, number>()
    for (const o of orgs.data ?? []) {
      const id = o.plan_id as string | null
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return (plans.data ?? []).map((p) => ({
      ...(p as SubscriptionPlan),
      monthly_fee_bdt: String(p.monthly_fee_bdt),
      agency_count: counts.get(p.id as string) ?? 0,
    }))
  },
)

export const upsertPlanFn = createServerFn({ method: 'POST' })
  .validator(planUpsertSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const row = {
      name: data.name,
      monthly_fee_bdt: data.monthly_fee_bdt,
      max_clients: data.max_clients,
      max_ad_accounts: data.max_ad_accounts,
      max_staff: data.max_staff,
      is_active: data.is_active,
      sort_order: data.sort_order,
      updated_at: new Date().toISOString(),
    }

    let before: Record<string, unknown> | null = null
    let id = data.id
    if (id) {
      const { data: existing } = await admin
        .from('subscription_plans')
        .select('*')
        .eq('id', id)
        .maybeSingle()
      if (!existing) throw new Error('Plan not found')
      before = existing as Record<string, unknown>
      const { error } = await admin.from('subscription_plans').update(row).eq('id', id)
      if (error) throw new Error(friendlyPlanError(error.message))
    } else {
      const { data: created, error } = await admin
        .from('subscription_plans')
        .insert(row)
        .select('id')
        .single()
      if (error) throw new Error(friendlyPlanError(error.message))
      id = created.id as string
    }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: data.id ? 'SUBSCRIPTION_PLAN_UPDATED' : 'SUBSCRIPTION_PLAN_CREATED',
      entityType: 'SUBSCRIPTION_PLAN',
      entityId: id,
      oldValues: before,
      newValues: row,
    })
    return { id: id! }
  })

function friendlyPlanError(message: string): string {
  return message.includes('subscription_plans_name_key')
    ? 'A plan with that name already exists.'
    : message
}

export interface OrganizationSubscription {
  plan: SubscriptionPlan | null
  billing_exempt: boolean
  usage: OrganizationUsage
  paid_through: string | null
  billing_status: BillingStatus
  payments: Array<{
    id: string
    amount_bdt: string
    period_start: string
    period_end: string
    paid_at: string
    method: string | null
    reference: string | null
    note: string | null
    plan_name: string | null
    recorded_by_name: string | null
  }>
}

export const getOrganizationSubscriptionFn = createServerFn({ method: 'GET' })
  .validator(subscriptionOrgSchema)
  .handler(async ({ data }): Promise<OrganizationSubscription> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: org } = await admin
      .from('organizations')
      .select('billing_exempt')
      .eq('id', data.organization_id)
      .maybeSingle()
    if (!org) throw new Error('Organization not found')

    const [plan, usage, payments] = await Promise.all([
      getOrganizationPlan(admin, data.organization_id),
      getOrganizationUsage(admin, data.organization_id),
      admin
        .from('subscription_payments')
        .select('*, plan:subscription_plans(name)')
        .eq('organization_id', data.organization_id)
        .order('period_end', { ascending: false })
        .order('created_at', { ascending: false }),
    ])
    if (payments.error) throw new Error(payments.error.message)

    const rows = (payments.data ?? []) as unknown as Array<{
      id: string
      amount_bdt: number | string
      period_start: string
      period_end: string
      paid_at: string
      method: string | null
      reference: string | null
      note: string | null
      recorded_by: string | null
      plan: { name: string } | null
    }>

    const recorderIds = [...new Set(rows.map((r) => r.recorded_by).filter(Boolean))] as string[]
    const names = new Map<string, string>()
    if (recorderIds.length > 0) {
      const { data: profiles } = await admin
        .from('user_profiles')
        .select('user_id, full_name')
        .in('user_id', recorderIds)
      for (const p of profiles ?? []) names.set(p.user_id as string, p.full_name as string)
    }

    const paidThrough = paidThroughFrom(rows)
    const billingExempt = (org as { billing_exempt: boolean }).billing_exempt
    return {
      plan: plan ? { ...plan, monthly_fee_bdt: String(plan.monthly_fee_bdt) } : null,
      billing_exempt: billingExempt,
      usage,
      paid_through: paidThrough,
      billing_status: billingStatus({
        billingExempt,
        planFeeBdt: plan ? plan.monthly_fee_bdt : null,
        paidThrough,
        today: dhakaToday(),
      }),
      payments: rows.map((r) => ({
        id: r.id,
        amount_bdt: String(r.amount_bdt),
        period_start: r.period_start,
        period_end: r.period_end,
        paid_at: r.paid_at,
        method: r.method,
        reference: r.reference,
        note: r.note,
        plan_name: r.plan?.name ?? null,
        recorded_by_name: r.recorded_by ? (names.get(r.recorded_by) ?? null) : null,
      })),
    }
  })

/** Plan + billing status for every agency, for the organizations list. */
export const listOrganizationBillingFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    Record<string, { plan_name: string | null; billing_status: BillingStatus; paid_through: string | null }>
  > => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const [orgs, payments] = await Promise.all([
      admin
        .from('organizations')
        .select('id, billing_exempt, plan:subscription_plans(name, monthly_fee_bdt)'),
      admin.from('subscription_payments').select('organization_id, period_end'),
    ])
    if (orgs.error) throw new Error(orgs.error.message)
    if (payments.error) throw new Error(payments.error.message)

    const byOrg = new Map<string, Array<{ period_end: string }>>()
    for (const p of payments.data ?? []) {
      const k = p.organization_id as string
      byOrg.set(k, [...(byOrg.get(k) ?? []), { period_end: p.period_end as string }])
    }
    const today = dhakaToday()
    const out: Record<string, { plan_name: string | null; billing_status: BillingStatus; paid_through: string | null }> = {}
    for (const o of (orgs.data ?? []) as unknown as Array<{
      id: string
      billing_exempt: boolean
      plan: { name: string; monthly_fee_bdt: number | string } | null
    }>) {
      const paidThrough = paidThroughFrom(byOrg.get(o.id) ?? [])
      out[o.id] = {
        plan_name: o.plan?.name ?? null,
        paid_through: paidThrough,
        billing_status: billingStatus({
          billingExempt: o.billing_exempt,
          planFeeBdt: o.plan ? o.plan.monthly_fee_bdt : null,
          paidThrough,
          today,
        }),
      }
    }
    return out
  },
)

/**
 * Put an agency on a plan (or none), and set whether it is billing-exempt.
 * Moving to a smaller plan never deletes anything: an agency over its new
 * limits keeps what it has and simply can't add more until it's back under.
 */
export const setOrganizationPlanFn = createServerFn({ method: 'POST' })
  .validator(setOrganizationPlanSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: before } = await admin
      .from('organizations')
      .select('id, plan_id, billing_exempt, plan:subscription_plans(name)')
      .eq('id', data.organization_id)
      .maybeSingle()
    if (!before) throw new Error('Organization not found')

    let newPlanName: string | null = null
    if (data.plan_id) {
      const { data: plan } = await admin
        .from('subscription_plans')
        .select('id, name')
        .eq('id', data.plan_id)
        .maybeSingle()
      if (!plan) throw new Error('Plan not found')
      newPlanName = plan.name as string
    }

    const { error } = await admin
      .from('organizations')
      .update({ plan_id: data.plan_id, billing_exempt: data.billing_exempt })
      .eq('id', data.organization_id)
    if (error) throw new Error(error.message)

    const b = before as unknown as {
      plan_id: string | null
      billing_exempt: boolean
      plan: { name: string } | null
    }
    await writeAudit({
      actorUserId: actor.id,
      organizationId: data.organization_id,
      action: 'SUBSCRIPTION_PLAN_CHANGED',
      entityType: 'ORGANIZATION',
      entityId: data.organization_id,
      oldValues: { plan: b.plan?.name ?? null, billing_exempt: b.billing_exempt },
      newValues: { plan: newPlanName, billing_exempt: data.billing_exempt },
    })
    return { ok: true }
  })

/**
 * Record a payment an agency made to the platform. Append-only: a mistake is
 * corrected by recording what actually happened, never by editing a row. The
 * agency's current plan is snapshotted on the row.
 */
export const recordSubscriptionPaymentFn = createServerFn({ method: 'POST' })
  .validator(recordSubscriptionPaymentSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { data: org } = await admin
      .from('organizations')
      .select('id, plan_id')
      .eq('id', data.organization_id)
      .maybeSingle()
    if (!org) throw new Error('Organization not found')

    const row = {
      organization_id: data.organization_id,
      plan_id: (org as { plan_id: string | null }).plan_id,
      amount_bdt: data.amount_bdt,
      period_start: data.period_start,
      period_end: data.period_end,
      method: data.method || null,
      reference: data.reference || null,
      note: data.note || null,
      recorded_by: actor.id,
    }
    const { data: created, error } = await admin
      .from('subscription_payments')
      .insert(row)
      .select('id')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: data.organization_id,
      action: 'SUBSCRIPTION_PAYMENT_RECORDED',
      entityType: 'SUBSCRIPTION_PAYMENT',
      entityId: created.id as string,
      newValues: row,
    })
    return { id: created.id as string }
  })
