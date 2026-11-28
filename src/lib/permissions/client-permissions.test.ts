import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_PERMISSION_KEYS,
  clientCan,
  clientPagePermission,
  normalizeClientPermissions,
  teamAccessRefusal,
  teamAddRefusal,
  teamStatusRefusal,
} from './client-permissions'

describe('client permissions', () => {
  it('match the database check constraint', () => {
    const sql = readFileSync('supabase/migrations/20260723000069_client_member_permissions.sql', 'utf8')
    const listed = /array\[([^\]]+)\]::text\[\]/.exec(sql)![1].match(/'([^']+)'/g)!.map((s) => s.slice(1, -1))
    expect(listed).toEqual([...CLIENT_PERMISSION_KEYS])
  })

  it('paying brings seeing billing with it; unknown keys drop', () => {
    expect(normalizeClientPermissions(['payments.create', 'nope'])).toEqual(['payments.create', 'billing.view'])
    expect(normalizeClientPermissions([])).toEqual([])
  })

  it('an Owner can do everything, a Member only what is ticked', () => {
    expect(clientCan({ isOwner: true, permissions: [] }, 'team.manage')).toBe(true)
    expect(clientCan({ isOwner: false, permissions: ['requests.create'] }, 'requests.create')).toBe(true)
    expect(clientCan({ isOwner: false, permissions: ['requests.create'] }, 'billing.view')).toBe(false)
    expect(clientCan(null, 'requests.create')).toBe(false)
  })

  it('gates only the billing pages', () => {
    expect(clientPagePermission('/client/due')).toBe('billing.view')
    expect(clientPagePermission('/client/statement/')).toBe('billing.view')
    expect(clientPagePermission('/client/payment-requests')).toBe('billing.view')
    expect(clientPagePermission('/client')).toBeNull()
    expect(clientPagePermission('/client/limit-requests')).toBeNull()
    expect(clientPagePermission('/client/team')).toBeNull()
  })
})

describe('team rules', () => {
  const owner = { userId: 'o1', isOwner: true, permissions: [] }
  const manager = { userId: 'm1', isOwner: false, permissions: ['team.manage', 'requests.create'] }
  const viewer = { userId: 'v1', isOwner: false, permissions: [] }
  const member = { userId: 'x', isOwner: false, status: 'ACTIVE' as const }
  const otherOwner = { userId: 'o2', isOwner: true, status: 'ACTIVE' as const }

  it('needs team.manage', () => {
    expect(teamAddRefusal(viewer, { isOwner: false, permissions: [] })).toMatch(/can’t manage/)
    expect(teamStatusRefusal(viewer, member, 'INACTIVE', 2)).toMatch(/can’t manage/)
  })

  it('only an owner touches owners', () => {
    expect(teamAddRefusal(manager, { isOwner: true, permissions: [] })).toMatch(/Only an owner/)
    expect(teamAccessRefusal(manager, otherOwner, { isOwner: true, permissions: [] }, 2)).toMatch(/Only an owner/)
    expect(teamAccessRefusal(manager, member, { isOwner: true, permissions: [] }, 2)).toMatch(/Only an owner/)
    expect(teamStatusRefusal(manager, otherOwner, 'INACTIVE', 2)).toMatch(/Only an owner/)
    expect(teamAccessRefusal(owner, otherOwner, { isOwner: false, permissions: [] }, 2)).toBeNull()
  })

  it('a manager hands out only what it has', () => {
    expect(teamAddRefusal(manager, { isOwner: false, permissions: ['requests.create'] })).toBeNull()
    expect(teamAddRefusal(manager, { isOwner: false, permissions: ['billing.view'] })).toMatch(/only give/)
    expect(teamAccessRefusal(manager, member, { isOwner: false, permissions: ['payments.create'] }, 1)).toMatch(/only give/)
  })

  it('nobody edits themself', () => {
    expect(teamAccessRefusal(owner, { ...otherOwner, userId: 'o1' }, { isOwner: false, permissions: [] }, 2)).toMatch(/own access/)
    expect(teamStatusRefusal(owner, { ...otherOwner, userId: 'o1' }, 'INACTIVE', 2)).toMatch(/own status/)
  })

  it('keeps one active owner', () => {
    expect(teamAccessRefusal(owner, otherOwner, { isOwner: false, permissions: [] }, 1)).toMatch(/at least one active owner/)
    expect(teamStatusRefusal(owner, otherOwner, 'INACTIVE', 1)).toMatch(/at least one active owner/)
    // An owner who's already off doesn't count.
    expect(teamAccessRefusal(owner, { ...otherOwner, status: 'INACTIVE' }, { isOwner: false, permissions: [] }, 1)).toBeNull()
  })
})
