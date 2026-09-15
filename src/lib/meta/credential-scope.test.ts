import { describe, expect, it } from 'vitest'
import {
  adAccountScopeFilter,
  credentialScopeKey,
  metaCredentialScopeFor,
} from './credential-scope'

const AGENCY_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const AGENCY_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

describe('metaCredentialScopeFor', () => {
  it("uses an owned account's own agency", () => {
    expect(
      metaCredentialScopeFor({ is_platform: false, organization_id: AGENCY_A }),
    ).toEqual({ kind: 'organization', organizationId: AGENCY_A })
  })

  it('uses the platform credentials for a pool account', () => {
    expect(
      metaCredentialScopeFor({ is_platform: true, organization_id: null }),
    ).toEqual({ kind: 'platform' })
  })

  it('never resolves a pool account to any organization', () => {
    // The whole point of the platform_settings split: a pool account's token
    // must not be reachable from an agency's Settings screen, which can only
    // ever write an { kind: 'organization' } scope.
    const scope = metaCredentialScopeFor({ is_platform: true, organization_id: null })
    expect(scope.kind).toBe('platform')
    expect(JSON.stringify(scope)).not.toContain('organizationId')
  })

  it('never falls back to the platform for a malformed owned account', () => {
    // The DB constraint makes this unreachable; failing loudly beats silently
    // reaching for the platform's token.
    expect(() =>
      metaCredentialScopeFor({ is_platform: false, organization_id: null }),
    ).toThrow(/no owning organization/)
  })
})

describe('credentialScopeKey', () => {
  it('separates the platform from every agency', () => {
    expect(credentialScopeKey({ kind: 'platform' })).toBe('platform')
    expect(
      credentialScopeKey({ kind: 'organization', organizationId: AGENCY_A }),
    ).toBe(`org:${AGENCY_A}`)
  })

  it('dedupes two accounts sharing one credential set', () => {
    const keys = new Set(
      [
        { is_platform: true, organization_id: null },
        { is_platform: true, organization_id: null },
        { is_platform: false, organization_id: AGENCY_A },
      ].map((a) => credentialScopeKey(metaCredentialScopeFor(a))),
    )
    expect(keys.size).toBe(2)
  })
})

describe('adAccountScopeFilter', () => {
  it('returns null with no grants, so the caller uses a plain equality filter', () => {
    expect(adAccountScopeFilter(AGENCY_A, [])).toBeNull()
  })

  it('unions owned accounts with granted ids', () => {
    expect(adAccountScopeFilter(AGENCY_A, ['id-1', 'id-2'])).toBe(
      `organization_id.eq.${AGENCY_A},id.in.(id-1,id-2)`,
    )
  })

  it("names only the caller's own organization", () => {
    const filter = adAccountScopeFilter(AGENCY_A, ['id-1'])
    expect(filter).not.toContain(AGENCY_B)
  })
})
