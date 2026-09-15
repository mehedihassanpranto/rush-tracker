import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncAdAccountSpendCap } from './spend-cap-sync.server'
import { fetchMetaAdAccount, updateMetaAdAccountSpendCap } from './meta.server'
import type { MetaAdAccountSummary } from './meta.server'

vi.mock('./meta.server', () => ({
  fetchMetaAdAccount: vi.fn(),
  updateMetaAdAccountSpendCap: vi.fn(),
}))

const mockFetch = vi.mocked(fetchMetaAdAccount)
const mockUpdate = vi.mocked(updateMetaAdAccountSpendCap)

function summary(over: Partial<MetaAdAccountSummary> = {}): MetaAdAccountSummary {
  return {
    external_account_id: 'act_123',
    name: 'Test Account',
    meta_status_code: 1,
    meta_status_label: 'Active',
    currency: 'USD',
    amount_spent: '0',
    spend_cap: '700.00',
    meta_balance: '0',
    ...over,
  }
}

/** A second agency's id — the point of these assertions is that the sync
 * uses the ACCOUNT'S OWN organization's Meta credentials, never an ambient
 * default. */
const ORG = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

const account = {
  external_account_id: 'act_123',
  current_limit_usd: '800.00',
  organization_id: ORG,
  is_platform: false,
}

describe('syncAdAccountSpendCap', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockUpdate.mockReset()
  })

  it('is not_applicable, with no Meta call at all, when unlinked', async () => {
    const outcome = await syncAdAccountSpendCap({
      external_account_id: null,
      current_limit_usd: '800.00',
      organization_id: ORG,
      is_platform: false,
    })
    expect(outcome).toEqual({ status: 'not_applicable' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('writes the new spend_cap and reports synced when it differs from live', async () => {
    mockFetch.mockResolvedValue(summary({ spend_cap: '700.00' }))
    mockUpdate.mockResolvedValue(undefined)

    const outcome = await syncAdAccountSpendCap(account)

    expect(outcome).toEqual({ status: 'synced' })
    expect(mockUpdate).toHaveBeenCalledWith('act_123', '800.00', {
      kind: 'organization',
      organizationId: ORG,
    })
  })

  it("reads Meta with the account's own organization credentials", async () => {
    mockFetch.mockResolvedValue(summary({ spend_cap: '800.00' }))

    await syncAdAccountSpendCap(account)

    expect(mockFetch).toHaveBeenCalledWith('act_123', {
      kind: 'organization',
      organizationId: ORG,
    })
  })

  it('uses the PLATFORM credentials for a pool account, not the operating agency', async () => {
    mockFetch.mockResolvedValue(summary({ spend_cap: '700.00' }))
    mockUpdate.mockResolvedValue(undefined)

    await syncAdAccountSpendCap({
      external_account_id: 'act_123',
      current_limit_usd: '800.00',
      // A pool account has no owning agency at all.
      organization_id: null,
      is_platform: true,
    })

    // The platform scope, NOT org zero's id: since migration 000037 the pool's
    // credentials are their own thing, and an organization id here would mean
    // reading app_settings for an agency that does not own this account.
    expect(mockFetch).toHaveBeenCalledWith('act_123', { kind: 'platform' })
    expect(mockUpdate).toHaveBeenCalledWith('act_123', '800.00', {
      kind: 'platform',
    })
  })

  it('is already_synced without calling updateMetaAdAccountSpendCap when already in sync (idempotency)', async () => {
    mockFetch.mockResolvedValue(summary({ spend_cap: '800.00' }))

    const outcome = await syncAdAccountSpendCap(account)

    expect(outcome).toEqual({ status: 'already_synced' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('is not_applicable, without writing, when the live Meta currency is not USD', async () => {
    mockFetch.mockResolvedValue(summary({ currency: 'BDT', spend_cap: '700.00' }))

    const outcome = await syncAdAccountSpendCap(account)

    expect(outcome).toEqual({ status: 'not_applicable' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('fails with a clear message, without writing, when the target is below amount already spent', async () => {
    mockFetch.mockResolvedValue(summary({ amount_spent: '850.00', spend_cap: '700.00' }))

    const outcome = await syncAdAccountSpendCap(account)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('would pause delivery')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('retries then fails when the Meta fetch keeps throwing', async () => {
    mockFetch.mockRejectedValue(new Error('Meta API request failed (500)'))

    const outcome = await syncAdAccountSpendCap(account)

    expect(outcome).toEqual({
      status: 'failed',
      error: 'Meta API request failed (500)',
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('retries then fails when the Meta write keeps throwing', async () => {
    mockFetch.mockResolvedValue(summary({ spend_cap: '700.00' }))
    mockUpdate.mockRejectedValue(new Error('Meta API request failed (400)'))

    const outcome = await syncAdAccountSpendCap(account)

    expect(outcome).toEqual({
      status: 'failed',
      error: 'Meta API request failed (400)',
    })
    expect(mockUpdate).toHaveBeenCalledTimes(2)
  })
})
