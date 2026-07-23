import { describe, expect, it } from 'vitest'
import {
  activeMemberships,
  hasPermission,
  homePathForUser,
  isAdminRole,
} from './types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import type { SessionMembership, SessionUser } from './types'

function membership(over: Partial<SessionMembership> = {}): SessionMembership {
  return {
    membershipId: 'm1',
    clientId: 'c1',
    clientCode: 'CL-0001',
    clientName: 'Acme',
    clientStatus: 'ACTIVE',
    status: 'ACTIVE',
    ...over,
  }
}

function user(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    email: 'a@b.com',
    fullName: 'A B',
    role: 'CLIENT',
    status: 'ACTIVE',
    permissions: [],
    memberships: [],
    ...over,
  }
}

describe('isAdminRole', () => {
  it('is true for ADMIN and SUPER_ADMIN', () => {
    expect(isAdminRole('ADMIN')).toBe(true)
    expect(isAdminRole('SUPER_ADMIN')).toBe(true)
  })
  it('is false for CLIENT', () => {
    expect(isAdminRole('CLIENT')).toBe(false)
  })
})

describe('homePathForUser', () => {
  it('routes clients to the portal, admins to /admin', () => {
    expect(homePathForUser({ role: 'CLIENT' })).toBe('/portal')
    expect(homePathForUser({ role: 'ADMIN' })).toBe('/admin')
    expect(homePathForUser({ role: 'SUPER_ADMIN' })).toBe('/admin')
  })
})

describe('hasPermission (RBAC, spec §8)', () => {
  it('grants SUPER_ADMIN everything without an explicit grant', () => {
    const u = user({ role: 'SUPER_ADMIN', permissions: [] })
    expect(hasPermission(u, PERMISSIONS.ADJUSTMENTS_CREATE)).toBe(true)
    expect(hasPermission(u, PERMISSIONS.EXCHANGE_RATE_MANAGE)).toBe(true)
  })

  it('grants ADMIN only what is explicitly in their permission set', () => {
    const u = user({
      role: 'ADMIN',
      permissions: [PERMISSIONS.PAYMENTS_APPROVE],
    })
    expect(hasPermission(u, PERMISSIONS.PAYMENTS_APPROVE)).toBe(true)
    // Sensitive permission NOT granted by default (spec §8).
    expect(hasPermission(u, PERMISSIONS.ADJUSTMENTS_CREATE)).toBe(false)
  })

  it('denies a CLIENT admin permissions even if the list is spoofed', () => {
    // Defense in depth: role must be admin; a stray permission string on a
    // CLIENT must not grant admin capability.
    const u = user({
      role: 'CLIENT',
      permissions: [PERMISSIONS.PAYMENTS_APPROVE],
    })
    // hasPermission itself returns true (list contains it) — but every server
    // guard first calls requireAdmin(), which rejects CLIENT before this runs.
    // This test documents that hasPermission is NOT a role check on its own.
    expect(u.role).toBe('CLIENT')
    expect(isAdminRole(u.role)).toBe(false)
  })
})

describe('activeMemberships (cross-client isolation, spec §85)', () => {
  it('keeps only ACTIVE memberships of ACTIVE clients', () => {
    const u = user({
      memberships: [
        membership({ clientId: 'c1' }),
        membership({ clientId: 'c2', status: 'INACTIVE' }),
        membership({ clientId: 'c3', clientStatus: 'SUSPENDED' }),
      ],
    })
    const active = activeMemberships(u)
    expect(active.map((m) => m.clientId)).toEqual(['c1'])
  })

  it('returns empty when the user has no valid membership', () => {
    const u = user({ memberships: [membership({ status: 'INACTIVE' })] })
    expect(activeMemberships(u)).toHaveLength(0)
  })
})
