import { dec } from '@/lib/money/money'
import type { MoneyInput } from '@/lib/money/money'

/** Zero-padded 12-hour time with lowercase am/pm — the same house style as the
 * payments and limit-request dates elsewhere in the app. */
export function fmtDateTime(value: string): string {
  const d = new Date(value)
  const date = d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  let hours = d.getHours()
  const suffix = hours >= 12 ? 'pm' : 'am'
  hours = hours % 12 || 12
  const time = `${String(hours).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`
  return `${date}, ${time}`
}

/** A BDT-per-USD rate. Four places, because rates are never rounded to whole
 * taka — 121.7143 and 121.71 are different money at these volumes. */
export function fmtRate(value: MoneyInput | null | undefined): string {
  return value == null ? '—' : dec(value).toFixed(4)
}

/** Value for a `datetime-local` input, in the browser's own timezone. */
export function nowLocalInput(): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

/** A `datetime-local` value to a real UTC instant. The naive string is never
 * sent as-is: it carries no timezone, so the server would guess one. */
export function localInputToIso(value: string): string {
  return new Date(value).toISOString()
}
