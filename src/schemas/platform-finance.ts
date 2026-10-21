import { z } from 'zod'
import { bankCode } from '@/schemas/usd-inventory'

/**
 * Platform suppliers (usd_sources) and the purchase list filter. Purchases
 * themselves are posted through Finance v2 (src/schemas/usd-inventory.ts).
 */

/**
 * How the dollars reach the platform. Defined once and read by both the source
 * dialog and the server-side enum, so the two cannot disagree. usd_sources.
 * payment_method is a plain text column with no CHECK on purpose — adding a
 * method here needs no migration.
 */
export const USD_PAYMENT_METHODS = [
  'Payoneer',
  'PayPal',
  'Wise',
  'Rizon',
  'Binance',
] as const
export type UsdPaymentMethod = (typeof USD_PAYMENT_METHODS)[number]

const sourceName = z
  .string()
  .trim()
  .min(1, 'Give the source a name')
  .max(60, 'Keep it under 60 characters')

const usdPaymentMethod = z.enum(USD_PAYMENT_METHODS, {
  message: 'Choose how this source pays in USD',
})

export const usdSourceCreateSchema = z.object({
  name: sourceName,
  payment_method: usdPaymentMethod,
  /** Bank the supplier is paid into — decides the bank fee (000059). */
  receiving_institution: bankCode.optional(),
})
export type UsdSourceCreateInput = z.infer<typeof usdSourceCreateSchema>

export const usdSourceUpdateSchema = z.object({
  id: z.uuid(),
  name: sourceName,
  payment_method: usdPaymentMethod,
  receiving_institution: bankCode.optional(),
})
export type UsdSourceUpdateInput = z.infer<typeof usdSourceUpdateSchema>

export const usdSourceStatusSchema = z.object({
  id: z.uuid(),
  is_active: z.boolean(),
})

export const usdPurchaseListSchema = z.object({
  source_id: z.uuid().optional(),
})
