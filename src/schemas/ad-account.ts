import { z } from 'zod'

const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => (v === '' ? undefined : v))

export const adAccountStatusEnum = z.enum([
  'AVAILABLE',
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
])

// USD limit: coerce from form input, decimal-safe boundaries enforced in DB.
const usdAmount = z.coerce
  .number({ message: 'Enter a valid amount' })
  .min(0, 'Cannot be negative')
  .max(1_000_000_000, 'Amount is too large')

// USD→BDT rate charged per dollar on the account. Must be positive: a zero
// rate would silently fall back to the client's rate at approval time.
const usdRate = z.coerce
  .number({ message: 'Enter a valid rate' })
  .gt(0, 'Must be greater than zero')
  .max(100_000, 'Rate is too large')

export const adAccountCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  external_account_id: optionalText,
  platform: z.string().trim().min(1).max(50).default('META'),
  current_limit_usd: usdAmount.default(0),
  usd_rate: usdRate,
  status: z.enum(['AVAILABLE', 'INACTIVE', 'SUSPENDED']).default('AVAILABLE'),
})

export const adAccountUpdateSchema = z.object({
  id: z.uuid(),
  external_account_id: optionalText,
  platform: z.string().trim().min(1).max(50),
  current_limit_usd: usdAmount,
  usd_rate: usdRate,
})

export const adAccountRenameSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1, 'Name is required').max(200),
})

export const adAccountStatusSchema = z.object({
  id: z.uuid(),
  status: adAccountStatusEnum,
})

export const assignSchema = z.object({
  ad_account_id: z.uuid(),
  client_id: z.uuid('Select a client'),
  notes: optionalText,
})

export const releaseSchema = z.object({
  ad_account_id: z.uuid(),
  notes: optionalText,
})

export const transferSchema = z.object({
  ad_account_id: z.uuid(),
  to_client_id: z.uuid('Select a client'),
  notes: optionalText,
})

export type AdAccountCreateInput = z.infer<typeof adAccountCreateSchema>
export type AdAccountUpdateInput = z.infer<typeof adAccountUpdateSchema>
export type AssignInput = z.infer<typeof assignSchema>
export type TransferInput = z.infer<typeof transferSchema>
