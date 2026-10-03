import { describe, expect, it } from 'vitest'
import { RATE_LIMITS, clientIpFrom, normalizeIdentifier, rateLimitDecision } from './rate-limit'

describe('rateLimitDecision', () => {
  it('allows under both limits', () => {
    expect(rateLimitDecision('login', { identifier: 4, ip: 29 })).toEqual({ allowed: true })
  })
  it('blocks the 6th failed login for one account', () => {
    expect(rateLimitDecision('login', { identifier: 5, ip: 0 })).toEqual({ allowed: false, retryAfterMinutes: 15 })
  })
  it('blocks one IP spraying many accounts', () => {
    expect(rateLimitDecision('login', { identifier: 0, ip: 30 }).allowed).toBe(false)
  })
  it('password reset allows 3 emails per account per hour', () => {
    expect(rateLimitDecision('reset', { identifier: 2, ip: 2 }).allowed).toBe(true)
    expect(rateLimitDecision('reset', { identifier: 3, ip: 3 })).toEqual({ allowed: false, retryAfterMinutes: 60 })
    expect(RATE_LIMITS.reset.countAll).toBe(true)
  })
})

describe('clientIpFrom', () => {
  it('takes the last hop — the one the trusted proxy added', () => {
    expect(clientIpFrom('6.6.6.6, 203.0.113.9', null)).toBe('203.0.113.9')
  })
  it('a single value is the client', () => {
    expect(clientIpFrom('203.0.113.9', null)).toBe('203.0.113.9')
  })
  it('falls back when there is no header', () => {
    expect(clientIpFrom(null, '10.0.0.1')).toBe('10.0.0.1')
    expect(clientIpFrom('', null)).toBeNull()
  })
})

describe('normalizeIdentifier', () => {
  it('emails compare case-insensitively', () => {
    expect(normalizeIdentifier('  Admin@Example.COM ')).toBe('admin@example.com')
  })
})
