import { describe, expect, it } from 'vitest'

import {
  TELEGRAM_EVENT_TYPES,
  eventTypesFor,
  isKnownEventType,
  labelForEventType,
} from './event-types'

describe('telegram event type catalog', () => {
  it('every event type declares at least one recipient type', () => {
    for (const e of TELEGRAM_EVENT_TYPES) {
      expect(e.recipientTypes.length).toBeGreaterThan(0)
    }
  })

  it('eventTypesFor only returns event types that list the given recipient type', () => {
    for (const t of ['platform_admin', 'agency', 'client'] as const) {
      const result = eventTypesFor(t)
      expect(result.every((e) => e.recipientTypes.includes(t))).toBe(true)
      // And nothing eligible for this recipient type is left out.
      const expectedIds = TELEGRAM_EVENT_TYPES.filter((e) =>
        e.recipientTypes.includes(t),
      ).map((e) => e.id)
      expect(result.map((e) => e.id).sort()).toEqual(expectedIds.sort())
    }
  })

  it('an event that can reach two recipient types shows up for both', () => {
    const forPlatform = eventTypesFor('platform_admin').map((e) => e.id)
    const forAgency = eventTypesFor('agency').map((e) => e.id)
    expect(forPlatform).toContain('meta.account_disabled')
    expect(forAgency).toContain('meta.account_disabled')
  })

  it('isKnownEventType is true only for catalog entries', () => {
    expect(isKnownEventType('payment.submitted')).toBe(true)
    expect(isKnownEventType('not_a_real_event')).toBe(false)
  })

  it('labelForEventType falls back to the raw id for an unknown type', () => {
    expect(labelForEventType('payment.submitted')).toBe('Client submitted a payment')
    expect(labelForEventType('mystery.event')).toBe('mystery.event')
  })
})
