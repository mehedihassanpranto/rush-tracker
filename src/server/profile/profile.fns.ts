import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireClientMembership } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { myProfileUpdateSchema } from '@/schemas/profile'

/**
 * Client-portal self-service profile edit (portal/profile). Deliberately
 * NOT a relaxed call into the admin-side updateClientUserProfileFn: that fn
 * is requireAdmin()-gated and also writes email via
 * admin.auth.admin.updateUserById(..., { email_confirm: true }), which
 * force-confirms a new address with no verification — fine for a trusted
 * admin fixing someone's login, not safe to expose to self-service. This fn
 * only touches full_name and derives the target user_id exclusively from
 * requireClientMembership()'s session — never accepted as input — so a
 * client can only ever edit their own profile. Email self-editing (with
 * proper re-verification) is a separate, larger concern and out of scope
 * here, same as password reset is out of scope for the admin-side edit.
 */
export const updateMyProfileFn = createServerFn({ method: 'POST' })
  .validator(myProfileUpdateSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { user: actor } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    const { error } = await admin
      .from('user_profiles')
      .update({ full_name: data.full_name })
      .eq('user_id', actor.id)
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'PROFILE_UPDATED',
      entityType: 'USER',
      entityId: actor.id,
      newValues: { full_name: data.full_name },
      metadata: { source: 'CLIENT_SELF_SERVICE' },
    })
    return { ok: true }
  })
