import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  setUserPermissionsSchema,
  setUserRoleSchema,
  setUserStatusSchema,
  staffUserCreateSchema,
} from '@/schemas/user'
import type { RoleKey, UserStatus } from '@/lib/auth/types'

const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const

export interface StaffUser {
  user_id: string
  full_name: string
  email: string
  role: RoleKey
  status: UserStatus
  /** Per-user permission grants (user_permissions) — beyond role defaults. */
  granted_permissions: Array<string>
}

export interface StaffUsersResult {
  users: Array<StaffUser>
  /** ADMIN role's default permission keys (always-on, not per-user grantable). */
  adminDefaultPermissions: Array<string>
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

/** Map permission key -> permission id. */
async function permissionIdByKey(): Promise<Map<string, string>> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin.from('permissions').select('id, key')
  const map = new Map<string, string>()
  for (const p of (data ?? []) as Array<{ id: string; key: string }>) {
    map.set(p.key, p.id)
  }
  return map
}

export const listStaffUsersFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<StaffUsersResult> => {
    await requireAdmin(PERMISSIONS.USERS_VIEW)
    const admin = getSupabaseAdminClient()

    const { data: profiles, error } = await admin
      .from('user_profiles')
      .select('user_id, full_name, status, role_id, role:roles(key)')
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)

    const rows = (profiles ?? []) as unknown as Array<{
      user_id: string
      full_name: string
      status: UserStatus
      role_id: string
      role: { key: RoleKey } | null
    }>
    const staff = rows.filter(
      (r) => r.role && STAFF_ROLES.includes(r.role.key as 'ADMIN'),
    )

    // Per-user permission grants in one query.
    const staffIds = staff.map((s) => s.user_id)
    const grantsByUser = new Map<string, Array<string>>()
    if (staffIds.length > 0) {
      const { data: grants } = await admin
        .from('user_permissions')
        .select('user_id, permission:permissions(key)')
        .in('user_id', staffIds)
      for (const g of (grants ?? []) as unknown as Array<{
        user_id: string
        permission: { key: string } | null
      }>) {
        if (!g.permission) continue
        const list = grantsByUser.get(g.user_id) ?? []
        list.push(g.permission.key)
        grantsByUser.set(g.user_id, list)
      }
    }

    // ADMIN role default permissions (always-on).
    const roles = await roleIdByKey()
    const adminRoleId = roles.get('ADMIN')
    let adminDefaultPermissions: Array<string> = []
    if (adminRoleId) {
      const { data: rp } = await admin
        .from('role_permissions')
        .select('permission:permissions(key)')
        .eq('role_id', adminRoleId)
      adminDefaultPermissions = (
        (rp ?? []) as unknown as Array<{ permission: { key: string } | null }>
      ).flatMap((r) => (r.permission ? [r.permission.key] : []))
    }

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
        granted_permissions: grantsByUser.get(s.user_id) ?? [],
      })
    }

    return { users, adminDefaultPermissions }
  },
)

/** Provision a new ADMIN / SUPER_ADMIN staff login (spec §7 "Manage admin users"). */
export const createStaffUserFn = createServerFn({ method: 'POST' })
  .validator(staffUserCreateSchema)
  .handler(async ({ data }): Promise<{ user_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: created, error } = await admin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      app_metadata: { app_role: data.role },
      user_metadata: { full_name: data.full_name },
    })
    if (error) throw new Error(error.message)
    const userId = created.user.id

    // The trigger creates the profile from app_role; ensure name + role.
    const roles = await roleIdByKey()
    const roleId = roles.get(data.role)
    await admin
      .from('user_profiles')
      .update({ full_name: data.full_name, ...(roleId ? { role_id: roleId } : {}) })
      .eq('user_id', userId)

    await writeAudit({
      actorUserId: actor.id,
      action: 'USER_CREATED',
      entityType: 'USER',
      entityId: userId,
      newValues: { email: data.email, role: data.role },
    })
    return { user_id: userId }
  })

export const setUserRoleFn = createServerFn({ method: 'POST' })
  .validator(setUserRoleSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_MANAGE)
    if (data.user_id === actor.id) {
      throw new Error('You cannot change your own role')
    }
    const admin = getSupabaseAdminClient()

    const roles = await roleIdByKey()
    const roleId = roles.get(data.role)
    if (!roleId) throw new Error('Unknown role')

    const { data: before } = await admin
      .from('user_profiles')
      .select('role:roles(key)')
      .eq('user_id', data.user_id)
      .single()
    const prevRole =
      (before as { role: { key: string } | null } | null)?.role?.key ?? null

    const { error } = await admin
      .from('user_profiles')
      .update({ role_id: roleId })
      .eq('user_id', data.user_id)
    if (error) throw new Error(error.message)

    // Keep the JWT app_role in sync (source of truth is user_profiles.role_id).
    await admin.auth.admin.updateUserById(data.user_id, {
      app_metadata: { app_role: data.role },
    })

    await writeAudit({
      actorUserId: actor.id,
      action: 'ROLE_CHANGED',
      entityType: 'USER',
      entityId: data.user_id,
      oldValues: { role: prevRole },
      newValues: { role: data.role },
    })
    return { ok: true }
  })

export const setUserStatusFn = createServerFn({ method: 'POST' })
  .validator(setUserStatusSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_MANAGE)
    if (data.user_id === actor.id) {
      throw new Error('You cannot change your own status')
    }
    const admin = getSupabaseAdminClient()

    const { error } = await admin
      .from('user_profiles')
      .update({ status: data.status })
      .eq('user_id', data.user_id)
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'USER_STATUS_CHANGED',
      entityType: 'USER',
      entityId: data.user_id,
      newValues: { status: data.status },
    })
    return { ok: true }
  })

/** Replace an ADMIN user's per-user permission grants (spec §8, §56). */
export const setUserPermissionsFn = createServerFn({ method: 'POST' })
  .validator(setUserPermissionsSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_MANAGE)
    if (data.user_id === actor.id) {
      throw new Error('You cannot change your own permissions')
    }
    const admin = getSupabaseAdminClient()

    // Only meaningful for ADMIN targets — SUPER_ADMIN already has everything.
    const { data: prof } = await admin
      .from('user_profiles')
      .select('role:roles(key)')
      .eq('user_id', data.user_id)
      .single()
    const targetRole =
      (prof as { role: { key: string } | null } | null)?.role?.key ?? null
    if (targetRole !== 'ADMIN') {
      throw new Error('Permissions can only be granted to Admin users')
    }

    const permMap = await permissionIdByKey()
    const permissionIds = data.permissions
      .map((k) => permMap.get(k))
      .filter((id): id is string => Boolean(id))

    // Replace the grant set: clear then insert the selection.
    const { error: delErr } = await admin
      .from('user_permissions')
      .delete()
      .eq('user_id', data.user_id)
    if (delErr) throw new Error(delErr.message)

    if (permissionIds.length > 0) {
      const { error: insErr } = await admin.from('user_permissions').insert(
        permissionIds.map((permission_id) => ({
          user_id: data.user_id,
          permission_id,
          granted_by: actor.id,
        })),
      )
      if (insErr) throw new Error(insErr.message)
    }

    await writeAudit({
      actorUserId: actor.id,
      action: 'PERMISSION_CHANGED',
      entityType: 'USER',
      entityId: data.user_id,
      newValues: { permissions: data.permissions },
    })
    return { ok: true }
  })
