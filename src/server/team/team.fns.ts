import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { provisionClientLogin } from '@/server/clients/client-login.server'
import {
  requireClientMembership,
  requireClientPermission,
} from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { activeOwnerCount, loadTeam, saveAccess } from '@/server/team/team-access.service'
import {
  CLIENT_PERMISSIONS,
  normalizeClientPermissions,
  teamAccessRefusal,
  teamAddRefusal,
  teamStatusRefusal,
} from '@/lib/permissions/client-permissions'
import { UserError } from '@/lib/errors/user-error'
import {
  addTeamMemberSchema,
  teamMemberAccessSchema,
  teamMemberStatusSchema,
} from '@/schemas/team'

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
  /** 000069: an Owner may do everything; a Member what `permissions` says. */
  is_owner: boolean
  permissions: Array<string>
}

/** Every login of the caller's client — anyone on the team may see who's on
 * it and what they can do. */
export const listMyTeamFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<TeamMemberRow>> => {
    const { user, membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    const [team, { data: profiles, error }] = await Promise.all([
      loadTeam(admin, membership.clientId, user.organizationId),
      admin
        .from('client_memberships')
        .select('user_id, profile:user_profiles(full_name)')
        .eq('client_id', membership.clientId)
        .eq('organization_id', user.organizationId),
    ])
    if (error) throw new Error(error.message)
    const names = new Map(
      ((profiles ?? []) as unknown as Array<{ user_id: string; profile: { full_name: string } | null }>).map(
        (p) => [p.user_id, p.profile?.full_name ?? ''],
      ),
    )

    const result: Array<TeamMemberRow> = []
    for (const m of team) {
      const { data: userRes } = await admin.auth.admin.getUserById(m.user_id)
      result.push({
        user_id: m.user_id,
        full_name: names.get(m.user_id) ?? '',
        email: userRes.user?.email ?? '',
        membership_status: m.status,
        is_owner: m.is_owner,
        permissions: m.permissions,
      })
    }
    return result
  },
)

/** The caller as a team actor, for the team rules. */
function teamActor(userId: string, membership: { isOwner: boolean; permissions: Array<string> }) {
  return { userId, isOwner: membership.isOwner, permissions: membership.permissions }
}

/** Add a teammate — creates (or, if the email already has a CLIENT login
 * for a different client, reuses) a CLIENT-role login scoped to the
 * caller's own client, with the access given (teamAddRefusal(): only an
 * Owner adds Owners; a Member with team.manage gives only what it has). See
 * client-login.server.ts for the reuse logic — same mechanism as the
 * agency's "Add login". */
export const addTeamMemberFn = createServerFn({ method: 'POST' })
  .validator(addTeamMemberSchema)
  .handler(async ({ data }): Promise<{ user_id: string; reused_existing_user: boolean }> => {
    const { user: actor, membership } = await requireClientPermission(CLIENT_PERMISSIONS.TEAM_MANAGE)
    const access = {
      isOwner: data.is_owner,
      permissions: data.is_owner ? [] : normalizeClientPermissions(data.permissions),
    }
    const refusal = teamAddRefusal(teamActor(actor.id, membership), access)
    if (refusal) throw new UserError(refusal)

    const { user_id: userId, reused_existing_user } = await provisionClientLogin({
      email: data.email,
      full_name: data.full_name,
      password: data.password,
      client_id: membership.clientId,
      organization_id: actor.organizationId,
      is_owner: access.isOwner,
      permissions: access.permissions,
    })

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'TEAM_MEMBER_ADDED',
      entityType: 'CLIENT',
      entityId: membership.clientId,
      newValues: {
        user_id: userId,
        email: data.email,
        reused_existing_user,
        is_owner: access.isOwner,
        permissions: access.permissions,
      },
      metadata: { source: 'CLIENT_SELF_SERVICE' },
    })
    return { user_id: userId, reused_existing_user }
  })

/** Change a teammate's access (teamAccessRefusal()). */
export const setTeamMemberAccessFn = createServerFn({ method: 'POST' })
  .validator(teamMemberAccessSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { user: actor, membership } = await requireClientPermission(CLIENT_PERMISSIONS.TEAM_MANAGE)
    const admin = getSupabaseAdminClient()
    const team = await loadTeam(admin, membership.clientId, actor.organizationId)
    const target = team.find((m) => m.user_id === data.user_id)
    if (!target) throw new Error('That teammate is not a member of your client')

    const next = {
      isOwner: data.is_owner,
      permissions: data.is_owner ? [] : normalizeClientPermissions(data.permissions),
    }
    const refusal = teamAccessRefusal(
      teamActor(actor.id, membership),
      { userId: target.user_id, isOwner: target.is_owner, status: target.status },
      next,
      activeOwnerCount(team),
    )
    if (refusal) throw new UserError(refusal)

    await saveAccess(admin, membership.clientId, actor.organizationId, data.user_id, {
      is_owner: next.isOwner,
      permissions: next.permissions,
    })
    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'TEAM_MEMBER_ACCESS_CHANGED',
      entityType: 'CLIENT',
      entityId: membership.clientId,
      oldValues: { user_id: target.user_id, is_owner: target.is_owner, permissions: target.permissions },
      newValues: { user_id: target.user_id, is_owner: next.isOwner, permissions: next.permissions },
      metadata: { source: 'CLIENT_SELF_SERVICE' },
    })
    return { ok: true }
  })

/** Activate/deactivate a teammate's portal access — restricted to
 * memberships under the caller's own client (teamStatusRefusal()). */
export const setTeamMemberStatusFn = createServerFn({ method: 'POST' })
  .validator(teamMemberStatusSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { user: actor, membership } = await requireClientPermission(CLIENT_PERMISSIONS.TEAM_MANAGE)
    const admin = getSupabaseAdminClient()
    const team = await loadTeam(admin, membership.clientId, actor.organizationId)
    const target = team.find((m) => m.user_id === data.user_id)
    if (!target) throw new Error('That teammate is not a member of your client')
    const refusal = teamStatusRefusal(
      teamActor(actor.id, membership),
      { userId: target.user_id, isOwner: target.is_owner, status: target.status },
      data.status,
      activeOwnerCount(team),
    )
    if (refusal) throw new UserError(refusal)

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
