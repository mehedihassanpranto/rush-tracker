import type { SupabaseClient } from '@supabase/supabase-js'

export interface TeamMembership {
  user_id: string
  status: 'ACTIVE' | 'INACTIVE'
  is_owner: boolean
  permissions: Array<string>
}

/** Every portal login of one client, with its access (000069). */
export async function loadTeam(
  admin: SupabaseClient,
  clientId: string,
  organizationId: string,
): Promise<Array<TeamMembership>> {
  const { data, error } = await admin
    .from('client_memberships')
    .select('user_id, status, is_owner, permissions')
    .eq('client_id', clientId)
    .eq('organization_id', organizationId)
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<TeamMembership>
}

export function activeOwnerCount(team: ReadonlyArray<TeamMembership>): number {
  return team.filter((m) => m.is_owner && m.status === 'ACTIVE').length
}

/** Set one login's access in one client. A Member's permissions are saved
 * as given (normalized by the caller); an Owner's are cleared. */
export async function saveAccess(
  admin: SupabaseClient,
  clientId: string,
  organizationId: string,
  userId: string,
  access: { is_owner: boolean; permissions: Array<string> },
): Promise<void> {
  const { data, error } = await admin
    .from('client_memberships')
    .update({
      is_owner: access.is_owner,
      permissions: access.is_owner ? [] : access.permissions,
    })
    .eq('client_id', clientId)
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .select('user_id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('That login is not a member of this client')
}
