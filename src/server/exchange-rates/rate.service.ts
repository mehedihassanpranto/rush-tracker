import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { dec } from '@/lib/money/money'

/** Current default USD→BDT rate as a string (server-only helper). */
export async function currentUsdRate(): Promise<string> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('exchange_rates')
    .select('rate')
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { rate: string } | null)?.rate ?? '0'
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
