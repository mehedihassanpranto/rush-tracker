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
  /** The organization (customer/tenant) this user belongs to — every
   * agency-scoped query in src/server/**\/*.fns.ts filters/tags by this.
   * Never null for a real user (multi-tenant migration backfilled every
   * profile to org zero); only meaningfully absent for a hypothetical
   * platform-admin-only account with no home organization, which does not
   * exist yet. */
  organizationId: string
  /** Cross-organization platform access (distinct from the per-organization
   * SUPER_ADMIN role — see the multi-tenant migration's notes). A platform
   * admin bypasses organization scoping entirely; guards and server fns
   * must check this before applying the normal organization_id filter. */
  isPlatformAdmin: boolean
  /** organizationId's live subscription_status, fetched fresh on every
   * session load (never cached in a JWT claim — see guards.server.ts and
   * the agency/client route guards, both of which gate on this). A
   * platform admin bypasses this entirely regardless of its value. */
  organizationSubscriptionStatus: 'active' | 'suspended' | 'cancelled'
}

/**
 * Where a signed-in user belongs. The platform panel and the agency app are
 * separate entities with separate accounts, so a platform admin goes
 * straight to /platform and never passes through the agency app — its own
 * organization_id exists only to satisfy the NOT NULL column and means
 * nothing for where they land.
 */
export function homePathForUser(
  user: Pick<SessionUser, 'role' | 'isPlatformAdmin'>,
): string {
  if (user.isPlatformAdmin) return '/platform'
  return user.role === 'CLIENT' ? '/client' : '/agency'
}

/**
 * What to CALL this account in the UI.
 *
 * `role` is the account's AGENCY role — what it may do inside one agency's
 * app. A platform account has no agency role at all, and since
 * `handle_new_user()` defaults every new signup to CLIENT, that is the value
 * sitting in the column. It is not a demotion and it grants nothing (the
 * platform account holds no client memberships either); it is simply the
 * absence of agency powers, and it is what keeps /agency closed to it.
 *
 * Printing it raw told the platform owner "Role: CLIENT", which reads as a
 * mistake and invites exactly the wrong fix — promoting the account to
 * SUPER_ADMIN, which would make it a super admin OF ORGANIZATION ZERO and hand
 * it xRush Agency's clients and ledger. That is precisely what separating the
 * platform from the agency removed. So the label is corrected here, in the UI,
 * and the column is left alone.
 */
export function displayRoleFor(
  user: Pick<SessionUser, 'role' | 'isPlatformAdmin'>,
): string {
  if (user.isPlatformAdmin) return 'Platform Owner'
  return user.role.replace('_', ' ')
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
