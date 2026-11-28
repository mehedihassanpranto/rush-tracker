import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PERMISSIONS } from './permissions'
import {
  ROLE_PERMISSION_KEYS,
  agencyPagePermission,
  canAssignRole,
  normalizeRolePermissions,
} from './agency-roles'

function serverSources(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return serverSources(path)
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [path] : []
  })
}

describe('agency roles', () => {
  it('can grant every permission the server checks', () => {
    const used = new Set<string>()
    for (const file of serverSources('src/server')) {
      for (const m of readFileSync(file, 'utf8').matchAll(/(?<![A-Z_])PERMISSIONS\.([A-Z_]+)/g)) {
        used.add(PERMISSIONS[m[1] as keyof typeof PERMISSIONS])
      }
    }
    expect(used.size).toBeGreaterThan(10)
    for (const key of used) expect(ROLE_PERMISSION_KEYS).toContain(key)
  })

  it('adds the view a manage permission needs, drops unknown keys', () => {
    expect(
      normalizeRolePermissions([
        PERMISSIONS.PAYMENTS_APPROVE,
        PERMISSIONS.CLIENTS_MANAGE,
        'finance.manage',
        'nonsense',
      ]),
    ).toEqual([
      PERMISSIONS.CLIENTS_VIEW,
      PERMISSIONS.CLIENTS_MANAGE,
      PERMISSIONS.PAYMENTS_VIEW,
      PERMISSIONS.PAYMENTS_APPROVE,
    ])
  })

  it('lets an admin assign only roles within their own permissions', () => {
    const admin = { role: 'ADMIN', permissions: [PERMISSIONS.USERS_MANAGE, PERMISSIONS.CLIENTS_VIEW] }
    expect(canAssignRole(admin, [PERMISSIONS.CLIENTS_VIEW])).toBe(true)
    expect(canAssignRole(admin, [PERMISSIONS.CLIENTS_VIEW, PERMISSIONS.PAYMENTS_APPROVE])).toBe(false)
    expect(canAssignRole({ role: 'SUPER_ADMIN', permissions: [] }, [PERMISSIONS.PAYMENTS_APPROVE])).toBe(true)
  })

  it('maps each agency page to the permission its list needs', () => {
    expect(agencyPagePermission('/agency')).toBe(PERMISSIONS.DASHBOARD_VIEW)
    expect(agencyPagePermission('/agency/')).toBe(PERMISSIONS.DASHBOARD_VIEW)
    expect(agencyPagePermission('/agency/payments')).toBe(PERMISSIONS.PAYMENTS_VIEW)
    expect(agencyPagePermission('/agency/payment-requests')).toBe(PERMISSIONS.PAYMENTS_VIEW)
    expect(agencyPagePermission('/agency/clients/abc')).toBe(PERMISSIONS.CLIENTS_VIEW)
    expect(agencyPagePermission('/agency/clientsx')).toBeNull()
    expect(agencyPagePermission('/agency/settings')).toBeNull()
  })
})
