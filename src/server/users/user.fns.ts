import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { assertPlanAllows } from '@/server/subscription/plan-limits.service'
import { listAgencyRoles, loadAgencyRole } from '@/server/users/agency-role.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { canAssignRole } from '@/lib/permissions/agency-roles'
import { UserError } from '@/lib/errors/user-error'
import {
  setUserRoleSchema,
  setUserStatusSchema,
  staffUserCreateSchema,
} from '@/schemas/user'
import type { RoleKey, SessionUser, UserStatus } from '@/lib/auth/types'
import type { SupabaseClient } from '@supabase/supabase-js'

const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const

export interface StaffUser {
  user_id: string
  full_name: string
  email: string
  role: RoleKey
  status: UserStatus
  /** The agency role (000068) of an ADMIN; null for a Super Admin, or an
   * admin still on the pre-roles defaults. */
  agency_role_id: string | null
  agency_role_name: string | null
}

/** Map role key -> role id (cached per request via a single query). */
async function roleIdByKey(): Promise<Map<string, string>> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin.from('roles').select('id, key')
  const map = new Map<string, string>()
  for (const r of (data ?? []) as Array<{ id: string; key: string }>) {
    map.set(r.key, r.id)
  }
  return map
}

export const listStaffUsersFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<StaffUser>> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_VIEW)
    const admin = getSupabaseAdminClient()

    const [{ data: profiles, error }, roles] = await Promise.all([
      admin
        .from('user_profiles')
        .select('user_id, full_name, status, agency_role_id, role:roles(key)')
        .eq('organization_id', actor.organizationId)
        .order('created_at', { ascending: true }),
      listAgencyRoles(admin, actor.organizationId),
    ])
    if (error) throw new Error(error.message)
    const roleNames = new Map(roles.map((r) => [r.id, r.name]))

    const staff = ((profiles ?? []) as unknown as Array<{
      user_id: string
      full_name: string
      status: UserStatus
      agency_role_id: string | null
      role: { key: RoleKey } | null
    }>).filter((r) => r.role && STAFF_ROLES.includes(r.role.key as 'ADMIN'))

    // Emails live in auth.users.
    const users: Array<StaffUser> = []
    for (const s of staff) {
      const { data: userRes } = await admin.auth.admin.getUserById(s.user_id)
      users.push({
        user_id: s.user_id,
        full_name: s.full_name,
        email: userRes.user?.email ?? '',
        role: s.role!.key,
        status: s.status,
        agency_role_id: s.agency_role_id,
        agency_role_name: s.agency_role_id ? (roleNames.get(s.agency_role_id) ?? null) : null,
      })
    }
    return users
  },
)

/**
 * What a role choice ('SUPER_ADMIN' or an agency role id) means, once the
 * actor is allowed to give it: only a Super Admin makes Super Admins, and
 * anyone else only hands out a role within their own permissions.
 */
async function resolveRoleChoice(
  admin: SupabaseClient,
  actor: SessionUser,
  choice: string,
): Promise<{ role: 'ADMIN' | 'SUPER_ADMIN'; agencyRoleId: string | null; label: string }> {
  if (choice === 'SUPER_ADMIN') {
    if (actor.role !== 'SUPER_ADMIN') {
      throw new UserError('Only a Super Admin can make someone a Super Admin')
    }
    return { role: 'SUPER_ADMIN', agencyRoleId: null, label: 'Super Admin' }
  }
  const role = await loadAgencyRole(admin, choice, actor.organizationId)
  if (!role) throw new Error('Role not found')
  if (!canAssignRole(actor, role.permissions)) {
    throw new UserError(
      `“${role.name}” includes permissions you don’t have, so you can’t give it to anyone`,
    )
  }
  return { role: 'ADMIN', agencyRoleId: role.id, label: role.name }
}

/** Provision a new staff login with a role (spec §7 "Manage admin users"). */
export const createStaffUserFn = createServerFn({ method: 'POST' })
  .validator(staffUserCreateSchema)
  .handler(async ({ data }): Promise<{ user_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_MANAGE)
    const admin = getSupabaseAdminClient()
    const choice = await resolveRoleChoice(admin, actor, data.role)
    await assertPlanAllows(admin, actor.organizationId, 'staff')

    const { data: created, error } = await admin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      app_metadata: { app_role: choice.role },
      user_metadata: { full_name: data.full_name },
    })
    if (error) throw new Error(error.message)
    const userId = created.user.id

    // The trigger creates the profile from app_role, organization_id
    // defaulted to org zero (it has no way to know the real target org) —
    // set name + role + the actor's own organization.
    const roles = await roleIdByKey()
    const roleId = roles.get(choice.role)
    const { error: profileError } = await admin
      .from('user_profiles')
      .update({
        full_name: data.full_name,
        organization_id: actor.organizationId,
        agency_role_id: choice.agencyRoleId,
        ...(roleId ? { role_id: roleId } : {}),
      })
      .eq('user_id', userId)
    if (profileError) throw new Error(profileError.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'USER_CREATED',
      entityType: 'USER',
      entityId: userId,
      newValues: {
        email: data.email,
        role: choice.role,
        agency_role_id: choice.agencyRoleId,
        agency_role: choice.label,
      },
    })
    return { user_id: userId }
  })

/** A staff login of the actor's own agency, or an error. */
async function loadStaffTarget(
  admin: SupabaseClient,
  actor: SessionUser,
  userId: string,
): Promise<{ role: RoleKey; agency_role_id: string | null }> {
  const { data } = await admin
    .from('user_profiles')
    .select('agency_role_id, role:roles(key)')
    .eq('user_id', userId)
    .eq('organization_id', actor.organizationId)
    .maybeSingle()
  const row = data as unknown as {
    agency_role_id: string | null
    role: { key: RoleKey } | null
  } | null
  if (!row?.role || !STAFF_ROLES.includes(row.role.key as 'ADMIN')) {
    throw new Error('User not found')
  }
  return { role: row.role.key, agency_role_id: row.agency_role_id }
}

export const setUserRoleFn = createServerFn({ method: 'POST' })
  .validator(setUserRoleSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_MANAGE)
    if (data.user_id === actor.id) {
      throw new UserError('You cannot change your own role')
    }
    const admin = getSupabaseAdminClient()

    const before = await loadStaffTarget(admin, actor, data.user_id)
    if (before.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      throw new UserError('Only a Super Admin can change a Super Admin’s role')
    }
    const choice = await resolveRoleChoice(admin, actor, data.role)

    const roles = await roleIdByKey()
    const roleId = roles.get(choice.role)
    if (!roleId) throw new Error('Unknown role')

    const { error } = await admin
      .from('user_profiles')
      .update({ role_id: roleId, agency_role_id: choice.agencyRoleId })
      .eq('user_id', data.user_id)
      .eq('organization_id', actor.organizationId)
    if (error) throw new Error(error.message)

    // Keep the JWT app_role in sync (source of truth is user_profiles.role_id).
    await admin.auth.admin.updateUserById(data.user_id, {
      app_metadata: { app_role: choice.role },
    })

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'ROLE_CHANGED',
      entityType: 'USER',
      entityId: data.user_id,
      oldValues: { role: before.role, agency_role_id: before.agency_role_id },
      newValues: {
        role: choice.role,
        agency_role_id: choice.agencyRoleId,
        agency_role: choice.label,
      },
    })
    return { ok: true }
  })

export const setUserStatusFn = createServerFn({ method: 'POST' })
  .validator(setUserStatusSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_MANAGE)
    if (data.user_id === actor.id) {
      throw new UserError('You cannot change your own status')
    }
    const admin = getSupabaseAdminClient()

    const target = await loadStaffTarget(admin, actor, data.user_id)
    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      throw new UserError('Only a Super Admin can change a Super Admin’s status')
    }

    if (data.status === 'ACTIVE') {
      const { data: before } = await admin
        .from('user_profiles')
        .select('status, is_platform_admin, role:roles(key)')
        .eq('user_id', data.user_id)
        .eq('organization_id', actor.organizationId)
        .maybeSingle()
      const b = before as unknown as {
        status: string
        is_platform_admin: boolean | null
        role: { key: string } | null
      } | null
      const isStaff = b?.role?.key === 'ADMIN' || b?.role?.key === 'SUPER_ADMIN'
      if (b && b.status !== 'ACTIVE' && isStaff && !b.is_platform_admin) {
        await assertPlanAllows(admin, actor.organizationId, 'staff')
      }
    }

    const { error } = await admin
      .from('user_profiles')
      .update({ status: data.status })
      .eq('user_id', data.user_id)
      .eq('organization_id', actor.organizationId)
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'USER_STATUS_CHANGED',
      entityType: 'USER',
      entityId: data.user_id,
      newValues: { status: data.status },
    })
    return { ok: true }
  })
