import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import {
  organizationStatusSchema,
  organizationUpdateSchema,
} from '@/schemas/organization'
import type { Organization } from '@/types/domain'

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
