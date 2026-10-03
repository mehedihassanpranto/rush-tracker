import { describe, expect, it } from 'vitest'
import { cronFreshness, isExpectedError, tokenState, unixToIso } from './health'
import { UserError } from '@/lib/errors/user-error'

const now = new Date('2026-10-02T12:00:00Z')

describe('cronFreshness', () => {
  it('never ran', () => expect(cronFreshness(null, now)).toBe('never'))
  it('ran within 26h is ok', () => expect(cronFreshness('2026-10-01T11:00:00Z', now)).toBe('ok'))
  it('older than 26h is stale', () => expect(cronFreshness('2026-10-01T09:00:00Z', now)).toBe('stale'))
})

describe('tokenState', () => {
  const base = { configured: true, valid: true, expiresAt: null, dataAccessExpiresAt: null }
  it('not configured', () => expect(tokenState({ ...base, configured: false }, now)).toBe('not_configured'))
  it('never-expiring valid token is ok', () => expect(tokenState(base, now)).toBe('ok'))
  it('invalid', () => expect(tokenState({ ...base, valid: false }, now)).toBe('invalid'))
  it('a check that could not reach Meta is unknown, not invalid', () =>
    expect(tokenState({ ...base, valid: null }, now)).toBe('unknown'))
  it('expiring within 7 days', () =>
    expect(tokenState({ ...base, expiresAt: '2026-10-06T00:00:00Z' }, now)).toBe('expiring'))
  it('data access expiring counts too', () =>
    expect(tokenState({ ...base, dataAccessExpiresAt: '2026-10-05T00:00:00Z' }, now)).toBe('expiring'))
  it('already expired is invalid', () =>
    expect(tokenState({ ...base, expiresAt: '2026-10-01T00:00:00Z' }, now)).toBe('invalid'))
  it('expiring in 30 days is ok', () =>
    expect(tokenState({ ...base, expiresAt: '2026-11-01T00:00:00Z' }, now)).toBe('ok'))
})

describe('unixToIso', () => {
  it('0 means never', () => expect(unixToIso(0)).toBeNull())
  it('converts seconds', () => expect(unixToIso(1790000000)).toBe('2026-09-21T14:13:20.000Z'))
})

describe('isExpectedError', () => {
  const named = (name: string) => Object.assign(new Error('x'), { name })
  it('auth, plan limit, validation and Meta-not-connected are expected', () => {
    for (const n of ['AuthError', 'PlanLimitError', 'ZodError', 'MetaNotConfiguredError']) {
      expect(isExpectedError(named(n))).toBe(true)
    }
  })
  it('a UserError (wrong password, expired link, …) is expected', () => {
    expect(isExpectedError(new UserError('Your current password is not correct.'))).toBe(true)
  })
  it('router control flow is expected', () => {
    expect(isExpectedError({ isRedirect: true })).toBe(true)
    expect(isExpectedError({ isNotFound: true })).toBe(true)
    expect(isExpectedError(new Response(null, { status: 302 }))).toBe(true)
  })
  it('anything else is a real error', () => {
    expect(isExpectedError(new Error('boom'))).toBe(false)
    expect(isExpectedError(new TypeError('x is undefined'))).toBe(false)
    expect(isExpectedError('string thrown')).toBe(false)
  })
})
