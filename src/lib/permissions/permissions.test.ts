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

  it('marks the three sensitive permissions and nothing else', () => {
    expect([...SENSITIVE_PERMISSIONS].sort()).toEqual(
      [
        PERMISSIONS.ADJUSTMENTS_CREATE,
        PERMISSIONS.EXCHANGE_RATE_MANAGE,
        PERMISSIONS.USERS_MANAGE,
      ].sort(),
    )
  })

  it('lists only valid keys as sensitive', () => {
    for (const key of SENSITIVE_PERMISSIONS) {
      expect(ALL_PERMISSION_KEYS).toContain(key)
    }
  })
})
