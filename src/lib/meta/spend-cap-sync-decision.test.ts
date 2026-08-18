import { describe, expect, it } from 'vitest'
import { decideSpendCapSync } from './spend-cap-sync-decision'

const base = {
  externalAccountId: 'act_123',
  liveCurrency: 'USD',
  liveAmountSpentUsd: '0',
  liveSpendCapUsd: '700.00',
  targetLimitUsd: '800.00',
}

describe('decideSpendCapSync', () => {
  it('is not_applicable/unlinked when there is no external_account_id', () => {
    expect(
      decideSpendCapSync({ ...base, externalAccountId: null }),
    ).toEqual({ action: 'not_applicable', reason: 'unlinked' })
  })

  it('is not_applicable/non_usd when the live Meta currency is not USD', () => {
    expect(
      decideSpendCapSync({ ...base, liveCurrency: 'BDT' }),
    ).toEqual({ action: 'not_applicable', reason: 'non_usd' })
  })

  it('is would_pause_delivery when the target is below amount already spent', () => {
    expect(
      decideSpendCapSync({
        ...base,
        liveAmountSpentUsd: '850.00',
        targetLimitUsd: '800.00',
      }),
    ).toEqual({ action: 'would_pause_delivery', amountSpentUsd: '850.00' })
  })

  it('is already_synced when the live spend_cap already equals the target', () => {
    expect(
      decideSpendCapSync({ ...base, liveSpendCapUsd: '800.00', targetLimitUsd: '800.00' }),
    ).toEqual({ action: 'already_synced' })
  })

  it('is write when the live spend_cap differs from the target', () => {
    expect(decideSpendCapSync(base)).toEqual({
      action: 'write',
      targetUsd: '800.00',
    })
  })

  it('is write when Meta reports no spend_cap at all', () => {
    expect(
      decideSpendCapSync({ ...base, liveSpendCapUsd: null }),
    ).toEqual({ action: 'write', targetUsd: '800.00' })
  })

  it('treats the boundary (target exactly equal to amount spent) as safe to write, not pausing', () => {
    expect(
      decideSpendCapSync({
        ...base,
        liveAmountSpentUsd: '800.00',
        targetLimitUsd: '800.00',
        liveSpendCapUsd: '700.00',
      }),
    ).toEqual({ action: 'write', targetUsd: '800.00' })
  })
})
