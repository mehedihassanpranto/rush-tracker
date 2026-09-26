import { z } from 'zod'
import { organizationId } from '@/schemas/organization'

/**
 * Platform USD/BDT stock ledger (spec §6.1). Amounts are entered, rates never
 * are — a rate is always bdt_amount / usd_amount, computed by the database per
 * transaction. `organizationId` (not z.uuid) because organization zero's
 * hand-picked sentinel id fails a strict RFC 4122 check.
 */

const usdAmount = z.coerce
  .number({ message: 'Enter a valid USD amount' })
  .positive('Must be greater than zero')
  .max(1_000_000_000, 'Amount is too large')

const bdtAmount = z.coerce
  .number({ message: 'Enter a valid BDT amount' })
  .positive('Must be greater than zero')
  .max(1_000_000_000_000, 'Amount is too large')

const isoDateTime = z.iso.datetime({ offset: true, message: 'Enter a valid date and time' })

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .optional()
    .transform((v) => (v ? v : undefined))

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
})
export type UsdSourceCreateInput = z.infer<typeof usdSourceCreateSchema>

export const usdSourceUpdateSchema = z.object({
  id: z.uuid(),
  name: sourceName,
  payment_method: usdPaymentMethod,
})
export type UsdSourceUpdateInput = z.infer<typeof usdSourceUpdateSchema>

export const usdSourceStatusSchema = z.object({
  id: z.uuid(),
  is_active: z.boolean(),
})

export const usdPurchaseCreateSchema = z.object({
  source_id: z.uuid('Choose a source'),
  usd_amount: usdAmount,
  bdt_amount: bdtAmount,
  method: optionalText(100),
  purchased_at: isoDateTime.optional(),
  notes: optionalText(1000),
})
export type UsdPurchaseCreateInput = z.infer<typeof usdPurchaseCreateSchema>

export const usdPurchaseListSchema = z.object({
  source_id: z.uuid().optional(),
})

export const usdSaleCreateSchema = z.object({
  organization_id: organizationId,
  ad_account_id: z.uuid().optional(),
  usd_amount: usdAmount,
  bdt_amount: bdtAmount,
  sold_at: isoDateTime.optional(),
  notes: optionalText(1000),
})
export type UsdSaleCreateInput = z.infer<typeof usdSaleCreateSchema>

export const usdSaleListSchema = z.object({
  organization_id: organizationId.optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export const agencyAdAccountsSchema = z.object({
  organization_id: organizationId,
})
