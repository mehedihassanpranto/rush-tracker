import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin, requireSuperAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { listAgencyRoles, loadAgencyRole } from '@/server/users/agency-role.service'
import { normalizeRolePermissions } from '@/lib/permissions/agency-roles'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { UserError } from '@/lib/errors/user-error'
import { agencyRoleSchema, agencyRoleUpdateSchema } from '@/schemas/user'
import type { AgencyRole } from '@/server/users/agency-role.service'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface AgencyRoleWithUsers extends AgencyRole {
  user_count: number
}

/** The agency's roles (000068) with how many staff logins hold each. */
export const listAgencyRolesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<AgencyRoleWithUsers>> => {
    const actor = await requireAdmin(PERMISSIONS.USERS_VIEW)
    const admin = getSupabaseAdminClient()
    const [roles, { data: holders, error }] = await Promise.all([
      listAgencyRoles(admin, actor.organizationId),
      admin
        .from('user_profiles')
        .select('agency_role_id')
        .eq('organization_id', actor.organizationId)
        .not('agency_role_id', 'is', null),
    ])
    if (error) throw new Error(error.message)
    const counts = new Map<string, number>()
    for (const h of (holders ?? []) as Array<{ agency_role_id: string }>) {
      counts.set(h.agency_role_id, (counts.get(h.agency_role_id) ?? 0) + 1)
    }
    return roles.map((r) => ({ ...r, user_count: counts.get(r.id) ?? 0 }))
  },
)

async function setRolePermissions(
  admin: SupabaseClient,
  roleId: string,
  organizationId: string,
  keys: Array<string>,
): Promise<void> {
  const { data: perms, error } = await admin
    .from('permissions')
    .select('id, key')
    .in('key', keys)
  if (error) throw new Error(error.message)
  const { error: delErr } = await admin
    .from('agency_role_permissions')
    .delete()
    .eq('role_id', roleId)
    .eq('organization_id', organizationId)
  if (delErr) throw new Error(delErr.message)
  const rows = ((perms ?? []) as Array<{ id: string }>).map((p) => ({
    role_id: roleId,
    permission_id: p.id,
    organization_id: organizationId,
  }))
  if (rows.length === 0) return
  const { error: insErr } = await admin.from('agency_role_permissions').insert(rows)
  if (insErr) throw new Error(insErr.message)
}

function friendlyRoleError(error: { code?: string; message: string }): Error {
  return error.code === '23505'
    ? new UserError('A role with that name already exists')
    : new Error(error.message)
}

/** Create a role. Super Admin only — editing roles changes what other
 * people may do, so it's kept with the one role that already has everything. */
export const createAgencyRoleFn = createServerFn({ method: 'POST' })
  .validator(agencyRoleSchema)
  .handler(async ({ data }): Promise<AgencyRole> => {
    const actor = await requireSuperAdmin()
    const admin = getSupabaseAdminClient()
    const permissions = normalizeRolePermissions(data.permissions)

    const { data: role, error } = await admin
      .from('agency_roles')
      .insert({
        organization_id: actor.organizationId,
        name: data.name,
        description: data.description,
      })
      .select('id')
      .single()
    if (error) throw friendlyRoleError(error)
    await setRolePermissions(admin, role.id as string, actor.organizationId, permissions)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'AGENCY_ROLE_CREATED',
      entityType: 'AGENCY_ROLE',
      entityId: role.id as string,
      newValues: { name: data.name, description: data.description, permissions },
    })
    return { id: role.id as string, name: data.name, description: data.description, permissions }
  })

export const updateAgencyRoleFn = createServerFn({ method: 'POST' })
  .validator(agencyRoleUpdateSchema)
  .handler(async ({ data }): Promise<AgencyRole> => {
    const actor = await requireSuperAdmin()
    const admin = getSupabaseAdminClient()
    const before = await loadAgencyRole(admin, data.id, actor.organizationId)
    if (!before) throw new Error('Role not found')
    const permissions = normalizeRolePermissions(data.permissions)

    const { error } = await admin
      .from('agency_roles')
      .update({
        name: data.name,
        description: data.description,
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
    if (error) throw friendlyRoleError(error)
    await setRolePermissions(admin, data.id, actor.organizationId, permissions)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'AGENCY_ROLE_UPDATED',
      entityType: 'AGENCY_ROLE',
      entityId: data.id,
      oldValues: { name: before.name, description: before.description, permissions: before.permissions },
      newValues: { name: data.name, description: data.description, permissions },
    })
    return { id: data.id, name: data.name, description: data.description, permissions }
  })

/** Delete a role nobody holds. */
export const deleteAgencyRoleFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireSuperAdmin()
    const admin = getSupabaseAdminClient()
    const before = await loadAgencyRole(admin, data.id, actor.organizationId)
    if (!before) throw new Error('Role not found')

    const { count, error: countErr } = await admin
      .from('user_profiles')
      .select('user_id', { count: 'exact', head: true })
      .eq('agency_role_id', data.id)
    if (countErr) throw new Error(countErr.message)
    if ((count ?? 0) > 0) {
      throw new UserError(
        `${count} staff ${count === 1 ? 'login has' : 'logins have'} this role — give them another role first`,
      )
    }

    const { error } = await admin
      .from('agency_roles')
      .delete()
      .eq('id', data.id)
      .eq('organization_id', actor.organizationId)
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'AGENCY_ROLE_DELETED',
      entityType: 'AGENCY_ROLE',
      entityId: data.id,
      oldValues: { name: before.name, permissions: before.permissions },
    })
    return { ok: true }
  })
