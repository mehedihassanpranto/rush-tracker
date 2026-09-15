import { describe, expect, it } from 'vitest'
import {
  ALL_PERMISSION_KEYS,
  PERMISSIONS,
  SENSITIVE_PERMISSIONS,
} from './permissions'

describe('permission catalog (spec §8)', () => {
  it('has no duplicate keys', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length)
  })

  it('exposes every value from PERMISSIONS', () => {
    expect(ALL_PERMISSION_KEYS.sort()).toEqual(
      Object.values(PERMISSIONS).sort(),
    )
  })

  // Deliberately an exact allow-list, not a count: marking a permission
  // sensitive restricts it to SUPER_ADMIN by default, and un-marking one
  // quietly widens who gets it. Adding a sensitive permission SHOULD fail this
  // test until it is listed here on purpose.
  // (The title used to say "four" and went stale when Finance added two —
  //  keep counts out of it.)
  it('marks exactly these permissions sensitive and nothing else', () => {
    expect([...SENSITIVE_PERMISSIONS].sort()).toEqual(
      [
        PERMISSIONS.ADJUSTMENTS_CREATE,
        PERMISSIONS.EXCHANGE_RATE_MANAGE,
        PERMISSIONS.USERS_MANAGE,
        PERMISSIONS.INTEGRATIONS_MANAGE,
        PERMISSIONS.FINANCE_VIEW,
        PERMISSIONS.FINANCE_MANAGE,
      ].sort(),
    )
  })

  it('lists only valid keys as sensitive', () => {
    for (const key of SENSITIVE_PERMISSIONS) {
      expect(ALL_PERMISSION_KEYS).toContain(key)
    }
  })
})
