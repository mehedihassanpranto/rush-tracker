import { canAssignRole } from '@/lib/permissions/agency-roles'
import type { SessionUser } from '@/lib/auth/types'
import type { AgencyRole } from '@/server/users/agency-role.service'

export interface RoleOption {
  /** 'SUPER_ADMIN' or an agency role id — what the server fns take. */
  value: string
  label: string
  /** Why it can't be picked, if it can't (the server refuses it too). */
  disabledReason: string | null
}

/** The roles `actor` may give a staff login: their agency's roles within
 * their own permissions, and Super Admin for a Super Admin. */
export function roleOptions(
  actor: Pick<SessionUser, 'role' | 'permissions'>,
  roles: ReadonlyArray<AgencyRole>,
): Array<RoleOption> {
  return [
    {
      value: 'SUPER_ADMIN',
      label: 'Super Admin — everything',
      disabledReason: actor.role === 'SUPER_ADMIN' ? null : 'Super Admins only',
    },
    ...roles.map((r) => ({
      value: r.id,
      label: r.name,
      disabledReason: canAssignRole(actor, r.permissions)
        ? null
        : 'Has permissions you don’t',
    })),
  ]
}
