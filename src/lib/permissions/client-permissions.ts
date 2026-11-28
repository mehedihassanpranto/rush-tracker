/**
 * What a client's portal logins may do (2026-11-28, migration 000069). An
 * Owner may do everything; a Member only what's ticked. Every login can see
 * the client's ad accounts and limit requests, its team and its own profile.
 */
export const CLIENT_PERMISSIONS = {
  REQUESTS_CREATE: 'requests.create',
  PAYMENTS_CREATE: 'payments.create',
  BILLING_VIEW: 'billing.view',
  TEAM_MANAGE: 'team.manage',
} as const

export type ClientPermission = (typeof CLIENT_PERMISSIONS)[keyof typeof CLIENT_PERMISSIONS]

/** In display order — must match the migration's check constraint. */
export const CLIENT_PERMISSION_KEYS: ReadonlyArray<ClientPermission> = [
  CLIENT_PERMISSIONS.REQUESTS_CREATE,
  CLIENT_PERMISSIONS.PAYMENTS_CREATE,
  CLIENT_PERMISSIONS.BILLING_VIEW,
  CLIENT_PERMISSIONS.TEAM_MANAGE,
]

export const CLIENT_PERMISSION_LABELS: Record<ClientPermission, { label: string; hint: string }> = {
  'requests.create': { label: 'Request limits', hint: 'Raise and cancel limit requests' },
  'payments.create': { label: 'Make payments', hint: 'Submit payments with proof' },
  'billing.view': { label: 'See billing', hint: 'Due, payments, payment requests and statement' },
  'team.manage': { label: 'Manage team', hint: 'Add members and set what they can do' },
}

/** Paying means seeing what's owed. */
const IMPLIED: Partial<Record<ClientPermission, ClientPermission>> = {
  'payments.create': 'billing.view',
}

/** A Member's keys as saved: known ones plus what they imply, in order. */
export function normalizeClientPermissions(keys: Iterable<string>): Array<ClientPermission> {
  const chosen = new Set<string>()
  for (const k of keys) {
    chosen.add(k)
    const implied = IMPLIED[k as ClientPermission]
    if (implied) chosen.add(implied)
  }
  return CLIENT_PERMISSION_KEYS.filter((k) => chosen.has(k))
}

export function clientCan(
  membership: { isOwner: boolean; permissions: ReadonlyArray<string> } | null | undefined,
  permission: ClientPermission,
): boolean {
  if (!membership) return false
  return membership.isOwner || membership.permissions.includes(permission)
}

/** The permission each portal page needs (null: every login). */
const PAGE_PERMISSIONS: ReadonlyArray<readonly [string, ClientPermission]> = [
  ['/client/due', CLIENT_PERMISSIONS.BILLING_VIEW],
  ['/client/payment-requests', CLIENT_PERMISSIONS.BILLING_VIEW],
  ['/client/statement', CLIENT_PERMISSIONS.BILLING_VIEW],
]

export function clientPagePermission(pathname: string): ClientPermission | null {
  const path = pathname.replace(/\/+$/, '')
  for (const [prefix, permission] of PAGE_PERMISSIONS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return permission
  }
  return null
}

export interface TeamActor {
  userId: string
  isOwner: boolean
  permissions: ReadonlyArray<string>
}

export interface TeamTarget {
  userId: string
  isOwner: boolean
  status: 'ACTIVE' | 'INACTIVE'
}

export interface TeamAccess {
  isOwner: boolean
  permissions: ReadonlyArray<string>
}

/**
 * The client's own team rules (a portal login managing teammates; the agency
 * isn't bound by them). null = allowed, else the reason shown to the user.
 * Only an Owner touches Owners; a Member with team.manage hands out only
 * permissions it holds; nobody edits themself; and a team never loses its
 * last active Owner.
 */
export function teamAddRefusal(actor: TeamActor, next: TeamAccess): string | null {
  if (!clientCan(actor, CLIENT_PERMISSIONS.TEAM_MANAGE)) return 'You can’t manage your team'
  if (!actor.isOwner && next.isOwner) return 'Only an owner can add an owner'
  if (!actor.isOwner && next.permissions.some((p) => !actor.permissions.includes(p))) {
    return 'You can only give permissions you have yourself'
  }
  return null
}

export function teamAccessRefusal(
  actor: TeamActor,
  target: TeamTarget,
  next: TeamAccess,
  activeOwners: number,
): string | null {
  if (!clientCan(actor, CLIENT_PERMISSIONS.TEAM_MANAGE)) return 'You can’t manage your team'
  if (target.userId === actor.userId) return 'You can’t change your own access'
  if (!actor.isOwner && (target.isOwner || next.isOwner)) {
    return 'Only an owner can make or change an owner'
  }
  if (!actor.isOwner && next.permissions.some((p) => !actor.permissions.includes(p))) {
    return 'You can only give permissions you have yourself'
  }
  if (target.isOwner && !next.isOwner && target.status === 'ACTIVE' && activeOwners <= 1) {
    return 'Your team needs at least one active owner'
  }
  return null
}

export function teamStatusRefusal(
  actor: TeamActor,
  target: TeamTarget,
  nextStatus: 'ACTIVE' | 'INACTIVE',
  activeOwners: number,
): string | null {
  if (!clientCan(actor, CLIENT_PERMISSIONS.TEAM_MANAGE)) return 'You can’t manage your team'
  if (target.userId === actor.userId) return 'You can’t change your own status'
  if (!actor.isOwner && target.isOwner) return 'Only an owner can turn an owner’s login on or off'
  if (
    target.isOwner &&
    target.status === 'ACTIVE' &&
    nextStatus === 'INACTIVE' &&
    activeOwners <= 1
  ) {
    return 'Your team needs at least one active owner'
  }
  return null
}
