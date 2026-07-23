/**
 * Canonical permission keys (spec §8). Must stay in sync with the
 * `permissions` table seeded in supabase/migrations.
 */
export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',

  CLIENTS_VIEW: 'clients.view',
  CLIENTS_MANAGE: 'clients.manage',

  AD_ACCOUNTS_VIEW: 'ad_accounts.view',
  AD_ACCOUNTS_MANAGE: 'ad_accounts.manage',
  AD_ACCOUNTS_ASSIGN: 'ad_accounts.assign',
  AD_ACCOUNTS_TRANSFER: 'ad_accounts.transfer',

  LIMIT_REQUESTS_VIEW: 'limit_requests.view',
  LIMIT_REQUESTS_APPROVE: 'limit_requests.approve',

  PAYMENTS_VIEW: 'payments.view',
  PAYMENTS_APPROVE: 'payments.approve',
  PAYMENT_REQUESTS_CREATE: 'payment_requests.create',

  LEDGER_VIEW: 'ledger.view',

  ADJUSTMENTS_VIEW: 'adjustments.view',
  ADJUSTMENTS_CREATE: 'adjustments.create',

  REPORTS_VIEW: 'reports.view',

  EXCHANGE_RATE_MANAGE: 'exchange_rate.manage',

  USERS_VIEW: 'users.view',
  USERS_MANAGE: 'users.manage',

  AUDIT_LOGS_VIEW: 'audit_logs.view',
} as const

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

export const ALL_PERMISSION_KEYS: Array<PermissionKey> =
  Object.values(PERMISSIONS)

/** Sensitive permissions that ADMIN does not get by default (spec §8). */
export const SENSITIVE_PERMISSIONS: Array<PermissionKey> = [
  PERMISSIONS.ADJUSTMENTS_CREATE,
  PERMISSIONS.EXCHANGE_RATE_MANAGE,
  PERMISSIONS.USERS_MANAGE,
]

/** Human-readable labels for the user-management UI. */
export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'dashboard.view': 'View dashboard',
  'clients.view': 'View clients',
  'clients.manage': 'Manage clients',
  'ad_accounts.view': 'View ad accounts',
  'ad_accounts.manage': 'Manage ad accounts',
  'ad_accounts.assign': 'Assign / release ad accounts',
  'ad_accounts.transfer': 'Transfer ad accounts',
  'limit_requests.view': 'View limit requests',
  'limit_requests.approve': 'Approve / reject limit requests',
  'payments.view': 'View payments',
  'payments.approve': 'Approve / reject payments',
  'payment_requests.create': 'Create payment requests',
  'ledger.view': 'View ledger',
  'adjustments.view': 'View adjustments',
  'adjustments.create': 'Create adjustments / reversals',
  'reports.view': 'View reports',
  'exchange_rate.manage': 'Manage default USD rate',
  'users.view': 'View users',
  'users.manage': 'Manage users / roles / permissions',
  'audit_logs.view': 'View audit logs',
}
