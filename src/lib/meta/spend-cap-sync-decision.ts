import { dec } from '@/lib/money/money'

/**
 * Pure "what should happen" branching for pushing an approved limit to
 * Meta's spend_cap — no I/O, so it's unit-testable without mocking Meta or
 * Supabase (same extraction pattern as src/lib/ledger/running-balance.ts).
 *
 * - not_applicable: this account was never going to auto-sync (no Meta
 *   link, or the linked account's live currency isn't USD — no FX
 *   conversion path exists in this app). Not a failure; nothing to alert on.
 * - already_synced: Meta's live spend_cap already equals the target — the
 *   idempotency guard that makes retries and duplicate triggers safe to
 *   re-run without re-POSTing.
 * - would_pause_delivery: pushing the target would set spend_cap below
 *   amount_spent already spent on Meta, which would pause delivery
 *   immediately — same guard updateMetaSpendCapFn already applies manually.
 * - write: push targetUsd to Meta.
 */
export type SpendCapSyncDecision =
  | { action: 'not_applicable'; reason: 'unlinked' | 'non_usd' }
  | { action: 'already_synced' }
  | { action: 'would_pause_delivery'; amountSpentUsd: string }
  | { action: 'write'; targetUsd: string }

export function decideSpendCapSync(input: {
  externalAccountId: string | null
  liveCurrency: string | null
  liveAmountSpentUsd: string | null
  liveSpendCapUsd: string | null
  targetLimitUsd: string
}): SpendCapSyncDecision {
  if (!input.externalAccountId) {
    return { action: 'not_applicable', reason: 'unlinked' }
  }
  if (input.liveCurrency !== 'USD') {
    return { action: 'not_applicable', reason: 'non_usd' }
  }

  const target = dec(input.targetLimitUsd)
  const amountSpent = dec(input.liveAmountSpentUsd ?? 0)
  if (target.lt(amountSpent)) {
    return {
      action: 'would_pause_delivery',
      amountSpentUsd: amountSpent.toFixed(2),
    }
  }

  if (
    input.liveSpendCapUsd != null &&
    dec(input.liveSpendCapUsd).eq(target)
  ) {
    return { action: 'already_synced' }
  }

  return { action: 'write', targetUsd: target.toFixed(2) }
}
