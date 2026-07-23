import Decimal from 'decimal.js'

/**
 * Decimal-safe money helpers (spec §38, Rule 28).
 *
 * All authoritative financial math happens in PostgreSQL (NUMERIC) inside
 * RPC transactions. These helpers are for server-side recalculation /
 * validation and display formatting — never trust frontend-computed totals.
 */

export type MoneyInput = string | number | Decimal

export function dec(value: MoneyInput): Decimal {
  return new Decimal(value)
}

/** amount × rate, rounded half-up to 2 decimal places (BDT charge). */
export function multiplyUsdByRate(
  usdAmount: MoneyInput,
  usdRate: MoneyInput,
): Decimal {
  return dec(usdAmount).mul(dec(usdRate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
}

export function addUsd(a: MoneyInput, b: MoneyInput): Decimal {
  return dec(a).plus(dec(b)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
}

const usdFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const bdtFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

export function formatUsd(value: MoneyInput): string {
  return `$${usdFormatter.format(dec(value).toNumber())}`
}

export function formatBdt(value: MoneyInput): string {
  return `৳${bdtFormatter.format(dec(value).toNumber())}`
}
