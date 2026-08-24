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

/** Cookie holding which of a CLIENT user's active memberships the portal
 * currently treats as "current" — read/written server-side only (see
 * auth.fns.ts's loadSessionUser and auth/portal-session.fns.ts). */
export const ACTIVE_CLIENT_COOKIE = 'rt_active_client'

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
  /** Which client's data the portal currently shows — one of `memberships`'
   * active entries, resolved from ACTIVE_CLIENT_COOKIE with a fallback to
   * the first active membership. Always null for non-CLIENT users or a
   * CLIENT with no active membership. */
  activeClientId: string | null
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

/** Pure resolution used by both session-loading (auth.fns.ts) and the
 * client-membership guard: an explicit cookie value wins if it names one of
 * the user's own active memberships, otherwise the first active one. */
export function resolveActiveClientId(
  active: Array<SessionMembership>,
  cookieClientId: string | null | undefined,
): string | null {
  if (active.length === 0) return null
  if (cookieClientId && active.some((m) => m.clientId === cookieClientId)) {
    return cookieClientId
  }
  return active[0].clientId
}
