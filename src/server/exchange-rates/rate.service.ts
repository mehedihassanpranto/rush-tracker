import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { dec } from '@/lib/money/money'

/** A client's configured USD→BDT rate as a string (server-only helper). */
export async function clientUsdRate(clientId: string): Promise<string> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('clients')
    .select('usd_rate')
    .eq('id', clientId)
    .maybeSingle()
  return (data as { usd_rate: string } | null)?.usd_rate ?? '0'
}

/**
 * The rate that governs limit requests on an ad account: the account's own
 * rate takes precedence over the client's, so an account bills at its own rate
 * regardless of who currently holds it.
 *
 * A zero/missing account rate means "unset" and falls back to the client rate,
 * so an account created before per-account rates existed is never billed at
 * zero. Client-level conversions (current due, dashboard totals) deliberately
 * keep using clientUsdRate — they aggregate across accounts, so no single
 * account rate applies.
 */
export async function adAccountUsdRate(
  adAccountId: string,
  clientId: string,
): Promise<string> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('ad_accounts')
    .select('usd_rate')
    .eq('id', adAccountId)
    .maybeSingle()
  const accountRate = (data as { usd_rate: string } | null)?.usd_rate ?? '0'
  if (dec(accountRate).gt(0)) return accountRate
  return clientUsdRate(clientId)
}

/**
 * Convert a BDT amount to USD at the given rate. This is an approximation for
 * display — the authoritative due is BDT, billed at historical rates. Returns
 * "0.00" when the rate is zero/invalid.
 */
export function bdtToUsd(bdt: string, rate: string): string {
  const r = dec(rate)
  if (r.lte(0)) return '0.00'
  return dec(bdt).div(r).toDecimalPlaces(2).toFixed(2)
}
