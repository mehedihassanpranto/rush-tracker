import { getSupabaseServerClient } from '@/lib/supabase/server'
import {
  activeMemberships,
  hasPermission,
  isAdminRole,
} from '@/lib/auth/types'
import { getCurrentUserFn } from './auth.fns'
import type { PermissionKey } from '@/lib/permissions/permissions'
import type { SessionMembership, SessionUser } from '@/lib/auth/types'

/**
 * Server-side authorization guards (spec §62).
 *
 * Every business server function must call one of these before doing work —
 * route-level protection is UX only, never the security boundary.
 */

export class AuthError extends Error {
  constructor(
    public readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

async function loadUserOrThrow(): Promise<SessionUser> {
  // getCurrentUserFn re-validates the JWT via supabase.auth.getUser().
  const user = await getCurrentUserFn()
  if (!user) throw new AuthError('UNAUTHENTICATED', 'Not signed in')
  return user
}

/** Any authenticated, ACTIVE user. */
export async function requireUser(): Promise<SessionUser> {
  return loadUserOrThrow()
}

/** ADMIN or SUPER_ADMIN, optionally holding a specific permission. */
export async function requireAdmin(
  permission?: PermissionKey,
): Promise<SessionUser> {
  const user = await loadUserOrThrow()
  if (!isAdminRole(user.role)) {
    throw new AuthError('FORBIDDEN', 'Admin access required')
  }
  if (permission && !hasPermission(user, permission)) {
    throw new AuthError('FORBIDDEN', `Missing permission: ${permission}`)
  }
  return user
}

/**
 * CLIENT user with at least one ACTIVE membership of an ACTIVE client.
 * When `clientId` is given, the user must be an active member of that exact
 * client — this is the cross-client isolation check.
 */
export async function requireClientMembership(clientId?: string): Promise<{
  user: SessionUser
  memberships: Array<SessionMembership>
  membership: SessionMembership
}> {
  const user = await loadUserOrThrow()
  if (user.role !== 'CLIENT') {
    throw new AuthError('FORBIDDEN', 'Client access required')
  }
  const active = activeMemberships(user)
  if (active.length === 0) {
    throw new AuthError('FORBIDDEN', 'No active client membership')
  }
  const membership = clientId
    ? active.find((m) => m.clientId === clientId)
    : active[0]
  if (!membership) {
    throw new AuthError('FORBIDDEN', 'Not a member of this client')
  }
  return { user, memberships: active, membership }
}

export { getSupabaseServerClient }
