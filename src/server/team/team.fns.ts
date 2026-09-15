import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { provisionClientLogin } from '@/server/clients/client-login.server'
import { requireClientMembership } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { addTeamMemberSchema, teamMemberStatusSchema } from '@/schemas/team'

/**
 * Client-portal "Team Members" — self-service portal logins for the
 * client's own staff, scoped to the caller's own client only. This has never
 * been the Employee/client_employees feature (agency staff assigned to service
 * clients) — that one was removed from the app on 2026-09-15, though its two
 * tables remain; the naming collision is why they were kept apart in the first
 * place. Team Members reuses the existing client_memberships /
 * user_profiles / auth.users mechanism the admin's "Add login" already
 * writes to, just with requireClientMembership() instead of requireAdmin(),
 * and the client_id always derived from the caller's own membership, never
 * trusted from input.
 */

export interface TeamMemberRow {
  user_id: string
  full_name: string
  email: string
  membership_status: 'ACTIVE' | 'INACTIVE'
}

export const listMyTeamFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<TeamMemberRow>> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    const { data: memberships, error } = await admin
      .from('client_memberships')
      .select('user_id, status, profile:user_profiles(full_name)')
      .eq('client_id', membership.clientId)
    if (error) throw new Error(error.message)

    const rows = (memberships ?? []) as unknown as Array<{
      user_id: string
      status: 'ACTIVE' | 'INACTIVE'
      profile: { full_name: string } | null
    }>

    const result: Array<TeamMemberRow> = []
    for (const m of rows) {
      const { data: userRes } = await admin.auth.admin.getUserById(m.user_id)
      result.push({
        user_id: m.user_id,
        full_name: m.profile?.full_name ?? '',
        email: userRes.user?.email ?? '',
        membership_status: m.status,
      })
    }
    return result
  },
)

/** Add a teammate — creates (or, if the email already has a CLIENT login
 * for a different client, reuses) a CLIENT-role login scoped to the
 * caller's own client. Any active member of a client can add another (no
 * owner/admin tier exists among client users). See client-login.server.ts
 * for the reuse logic — same mechanism as the admin's "Add login". */
export const addTeamMemberFn = createServerFn({ method: 'POST' })
  .validator(addTeamMemberSchema)
  .handler(async ({ data }): Promise<{ user_id: string; reused_existing_user: boolean }> => {
    const { user: actor, membership } = await requireClientMembership()

    const { user_id: userId, reused_existing_user } = await provisionClientLogin({
      email: data.email,
      full_name: data.full_name,
      password: data.password,
      client_id: membership.clientId,
      organization_id: actor.organizationId,
    })

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'TEAM_MEMBER_ADDED',
      entityType: 'CLIENT',
      entityId: membership.clientId,
      newValues: { user_id: userId, email: data.email, reused_existing_user },
      metadata: { source: 'CLIENT_SELF_SERVICE' },
    })
    return { user_id: userId, reused_existing_user }
  })

/** Activate/deactivate a teammate's portal access — restricted to
 * memberships under the caller's own client, checked server-side. */
export const setTeamMemberStatusFn = createServerFn({ method: 'POST' })
  .validator(teamMemberStatusSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { user: actor, membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    const { data: updated, error } = await admin
      .from('client_memberships')
      .update({ status: data.status })
      .eq('user_id', data.user_id)
      .eq('client_id', membership.clientId)
      .select('user_id')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!updated) {
      throw new Error('That teammate is not a member of your client')
    }

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'TEAM_MEMBER_STATUS_CHANGED',
      entityType: 'CLIENT',
      entityId: membership.clientId,
      newValues: { user_id: data.user_id, status: data.status },
      metadata: { source: 'CLIENT_SELF_SERVICE' },
    })
    return { ok: true }
  })
