import { dec } from '@/lib/money/money'
import type { MoneyInput } from '@/lib/money/money'

/**
 * The accounts whose own rate differs from `rate` — the ones a client-rate
 * change must rewrite. An account's own rate wins over its client's
 * (adAccountUsdRate()), and assigning copies the client's rate onto the
 * account (000057), so editing only the client's rate leaves every existing
 * account billing at the old one. An unset rate (0) already follows the
 * client's, so it's left alone.
 */
export function accountsOffRate<T extends { usd_rate: MoneyInput | null }>(
  accounts: ReadonlyArray<T>,
  rate: MoneyInput,
): Array<T> {
  let target
  try {
    target = dec(rate)
  } catch {
    return []
  }
  if (!target.gt(0)) return []
  return accounts.filter((a) => {
    const own = dec(a.usd_rate ?? 0)
    return own.gt(0) && !own.eq(target)
  })
}
