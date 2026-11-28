import type { SupabaseClient } from '@supabase/supabase-js'

export interface AgencyRole {
  id: string
  name: string
  description: string | null
  permissions: Array<string>
}

type RoleRow = {
  id: string
  name: string
  description: string | null
  grants: Array<{ permission: { key: string } | null }> | null
}

const ROLE_COLUMNS =
  'id, name, description, grants:agency_role_permissions(permission:permissions(key))'

function toRole(row: RoleRow): AgencyRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: (row.grants ?? []).flatMap((g) => (g.permission ? [g.permission.key] : [])),
  }
}

/** One of an agency's roles (000068), with its permission keys — null when
 * the id isn't a role of that agency. */
export async function loadAgencyRole(
  admin: SupabaseClient,
  roleId: string,
  organizationId: string,
): Promise<AgencyRole | null> {
  const { data, error } = await admin
    .from('agency_roles')
    .select(ROLE_COLUMNS)
    .eq('id', roleId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toRole(data as unknown as RoleRow) : null
}

/** Every role of one agency, by name. */
export async function listAgencyRoles(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Array<AgencyRole>> {
  const { data, error } = await admin
    .from('agency_roles')
    .select(ROLE_COLUMNS)
    .eq('organization_id', organizationId)
    .order('name')
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as Array<RoleRow>).map(toRole)
}
