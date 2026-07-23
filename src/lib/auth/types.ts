import type { PermissionKey } from '@/lib/permissions/permissions'

export type RoleKey = 'SUPER_ADMIN' | 'ADMIN' | 'CLIENT'

export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
export type ClientStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
export type MembershipStatus = 'ACTIVE' | 'INACTIVE'

export interface SessionMembership {
  membershipId: string
  clientId: string
  clientCode: string
  clientName: string
  clientStatus: ClientStatus
  status: MembershipStatus
}

/**
 * The authenticated user as exposed to routes/components. Built server-side
 * in auth.fns.ts — the browser never computes roles or permissions.
 */
export interface SessionUser {
  id: string
  email: string
  fullName: string
  role: RoleKey
  status: UserStatus
  permissions: Array<PermissionKey | (string & {})>
  memberships: Array<SessionMembership>
}

export function homePathForUser(user: Pick<SessionUser, 'role'>): string {
  return user.role === 'CLIENT' ? '/portal' : '/admin'
}

export function isAdminRole(role: RoleKey): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN'
}

export function hasPermission(
  user: Pick<SessionUser, 'role' | 'permissions'>,
  permission: PermissionKey,
): boolean {
  if (user.role === 'SUPER_ADMIN') return true
  return user.permissions.includes(permission)
}

export function activeMemberships(
  user: Pick<SessionUser, 'memberships'>,
): Array<SessionMembership> {
  return user.memberships.filter(
    (m) => m.status === 'ACTIVE' && m.clientStatus === 'ACTIVE',
  )
}
