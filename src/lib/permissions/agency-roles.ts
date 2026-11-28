import { PERMISSIONS } from './permissions'
import type { PermissionKey } from './permissions'

/**
 * What an agency's own roles are built from (2026-11-28, migration 000068).
 * Every permission an agency server fn checks belongs to a group here —
 * agency-roles.test.ts scans src/server to keep it that way. Left out on
 * purpose: exchange_rate.manage and finance.* (nothing on the agency side
 * checks them; agency Finance is Super Admin only).
 */
export const ROLE_PERMISSION_GROUPS: ReadonlyArray<{
  label: string
  keys: ReadonlyArray<PermissionKey>
}> = [
  { label: 'Dashboard', keys: [PERMISSIONS.DASHBOARD_VIEW] },
  { label: 'Clients', keys: [PERMISSIONS.CLIENTS_VIEW, PERMISSIONS.CLIENTS_MANAGE] },
  {
    label: 'Ad accounts',
    keys: [
      PERMISSIONS.AD_ACCOUNTS_VIEW,
      PERMISSIONS.AD_ACCOUNTS_MANAGE,
      PERMISSIONS.AD_ACCOUNTS_ASSIGN,
      PERMISSIONS.AD_ACCOUNTS_TRANSFER,
    ],
  },
  {
    label: 'Limit requests',
    keys: [PERMISSIONS.LIMIT_REQUESTS_VIEW, PERMISSIONS.LIMIT_REQUESTS_APPROVE],
  },
  {
    label: 'Payments',
    keys: [
      PERMISSIONS.PAYMENTS_VIEW,
      PERMISSIONS.PAYMENTS_APPROVE,
      PERMISSIONS.PAYMENT_REQUESTS_CREATE,
    ],
  },
  {
    label: 'Ledger & adjustments',
    keys: [
      PERMISSIONS.LEDGER_VIEW,
      PERMISSIONS.ADJUSTMENTS_VIEW,
      PERMISSIONS.ADJUSTMENTS_CREATE,
    ],
  },
  { label: 'Reports & audit', keys: [PERMISSIONS.REPORTS_VIEW, PERMISSIONS.AUDIT_LOGS_VIEW] },
  {
    label: 'Staff & settings',
    keys: [
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.USERS_MANAGE,
      PERMISSIONS.INTEGRATIONS_MANAGE,
    ],
  },
]

export const ROLE_PERMISSION_KEYS: ReadonlyArray<PermissionKey> =
  ROLE_PERMISSION_GROUPS.flatMap((g) => g.keys)

/** Acting on something needs seeing it: each key's page permission. */
export const IMPLIED_PERMISSIONS: Partial<Record<PermissionKey, PermissionKey>> = {
  [PERMISSIONS.CLIENTS_MANAGE]: PERMISSIONS.CLIENTS_VIEW,
  [PERMISSIONS.AD_ACCOUNTS_MANAGE]: PERMISSIONS.AD_ACCOUNTS_VIEW,
  [PERMISSIONS.AD_ACCOUNTS_ASSIGN]: PERMISSIONS.AD_ACCOUNTS_VIEW,
  [PERMISSIONS.AD_ACCOUNTS_TRANSFER]: PERMISSIONS.AD_ACCOUNTS_VIEW,
  [PERMISSIONS.LIMIT_REQUESTS_APPROVE]: PERMISSIONS.LIMIT_REQUESTS_VIEW,
  [PERMISSIONS.PAYMENTS_APPROVE]: PERMISSIONS.PAYMENTS_VIEW,
  [PERMISSIONS.PAYMENT_REQUESTS_CREATE]: PERMISSIONS.PAYMENTS_VIEW,
  [PERMISSIONS.ADJUSTMENTS_CREATE]: PERMISSIONS.ADJUSTMENTS_VIEW,
  [PERMISSIONS.USERS_MANAGE]: PERMISSIONS.USERS_VIEW,
}

/** A role's keys as saved: only role-grantable ones, plus what they imply,
 * in catalogue order. */
export function normalizeRolePermissions(
  keys: Iterable<string>,
): Array<PermissionKey> {
  const chosen = new Set<string>()
  for (const k of keys) {
    chosen.add(k)
    const implied = IMPLIED_PERMISSIONS[k as PermissionKey]
    if (implied) chosen.add(implied)
  }
  return ROLE_PERMISSION_KEYS.filter((k) => chosen.has(k))
}

/**
 * Whether `actor` may give someone a role holding `rolePermissions`. A Super
 * Admin may give any; anyone else only a role whose every permission they hold
 * themselves, so managing users can't be used to hand out more than you have.
 */
export function canAssignRole(
  actor: { role: string; permissions: ReadonlyArray<string> },
  rolePermissions: ReadonlyArray<string>,
): boolean {
  if (actor.role === 'SUPER_ADMIN') return true
  const own = new Set(actor.permissions)
  return rolePermissions.every((k) => own.has(k))
}

/**
 * The permission an agency page needs — the one its list server fn checks.
 * null: open to every agency admin (Settings, Finance — Finance has its own
 * Super Admin gate).
 */
const PAGE_PERMISSIONS: ReadonlyArray<readonly [string, PermissionKey]> = [
  ['/agency/clients', PERMISSIONS.CLIENTS_VIEW],
  ['/agency/ad-accounts', PERMISSIONS.AD_ACCOUNTS_VIEW],
  ['/agency/limit-requests', PERMISSIONS.LIMIT_REQUESTS_VIEW],
  ['/agency/payments', PERMISSIONS.PAYMENTS_VIEW],
  ['/agency/payment-requests', PERMISSIONS.PAYMENTS_VIEW],
  ['/agency/ledger', PERMISSIONS.LEDGER_VIEW],
  ['/agency/adjustments', PERMISSIONS.ADJUSTMENTS_VIEW],
  ['/agency/reports', PERMISSIONS.REPORTS_VIEW],
  ['/agency/audit', PERMISSIONS.AUDIT_LOGS_VIEW],
  ['/agency/users', PERMISSIONS.USERS_VIEW],
  ['/agency/search', PERMISSIONS.DASHBOARD_VIEW],
]

export function agencyPagePermission(pathname: string): PermissionKey | null {
  const path = pathname.replace(/\/+$/, '')
  if (path === '/agency') return PERMISSIONS.DASHBOARD_VIEW
  for (const [prefix, permission] of PAGE_PERMISSIONS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return permission
  }
  return null
}
