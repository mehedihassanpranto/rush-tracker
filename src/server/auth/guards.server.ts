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
    public readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'SUBSCRIPTION_SUSPENDED',
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
  // Multi-tenant subscription gate (Phase 3): the actual enforcement point
  // for "flipping the toggle takes effect immediately" — organizationSubscriptionStatus
  // is fetched fresh on every session load (auth.fns.ts), never from a
  // cached JWT claim. This is the real security boundary; the agency/client
  // route guards' redirect to /subscription-suspended is UX only, same as
  // every other route-level check in this app. Platform admins bypass
  // entirely, regardless of their own organization's status.
  if (!user.isPlatformAdmin && user.organizationSubscriptionStatus !== 'active') {
    throw new AuthError('SUBSCRIPTION_SUSPENDED', 'Your organization’s subscription is not active')
  }
  return user
}

/** Any authenticated, ACTIVE user. */
export async function requireUser(): Promise<SessionUser> {
  return loadUserOrThrow()
}

/**
 * Cross-organization platform access (Phase 2's organizations panel and any
 * future platform-level tooling) — distinct from requireAdmin(), which is
 * scoped to the caller's own organization. Deliberately does NOT go through
 * loadUserOrThrow()'s subscription-suspended check by re-deriving it here:
 * a platform admin must always reach this, even if — hypothetically — their
 * own organization's subscription were ever something other than active,
 * since they're the one who manages every organization's subscription
 * status in the first place.
 */
export async function requirePlatformAdmin(): Promise<SessionUser> {
  const user = await getCurrentUserFn()
  if (!user) throw new AuthError('UNAUTHENTICATED', 'Not signed in')
  if (!user.isPlatformAdmin) {
    throw new AuthError('FORBIDDEN', 'Platform admin access required')
  }
  return user
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
 * client — this is the cross-client isolation check (fails hard if not).
 * When omitted, resolves to the user's "current" client — one of possibly
 * several a login can belong to — via `user.activeClientId` (the
 * ACTIVE_CLIENT_COOKIE-backed selection computed at session load), falling
 * back to the first active membership if that's unset/stale.
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
  if (clientId) {
    const membership = active.find((m) => m.clientId === clientId)
    if (!membership) {
      throw new AuthError('FORBIDDEN', 'Not a member of this client')
    }
    return { user, memberships: active, membership }
  }
  const membership =
    active.find((m) => m.clientId === user.activeClientId) ?? active[0]
  return { user, memberships: active, membership }
}

export { getSupabaseServerClient }
