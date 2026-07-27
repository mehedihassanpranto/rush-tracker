import { z } from 'zod'

const optionalText = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v === '' ? undefined : v))

export const clientStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED'])

// USD→BDT rate charged per dollar for this client.
const usdRate = z.coerce
  .number({ message: 'Enter a valid rate' })
  .positive('Must be greater than zero')
  .max(100_000, 'Rate is too large')

export const clientCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  company_name: optionalText,
  email: z
    .union([z.literal(''), z.email('Enter a valid email')])
    .optional()
    .transform((v) => (v ? v : undefined)),
  phone: optionalText,
  address: optionalText,
  usd_rate: usdRate,
  status: clientStatusEnum.default('ACTIVE'),
})

export const clientUpdateSchema = clientCreateSchema.extend({
  id: z.uuid(),
})

export const clientStatusSchema = z.object({
  id: z.uuid(),
  status: clientStatusEnum,
})

export const clientUserCreateSchema = z.object({
  client_id: z.uuid(),
  full_name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})

export type ClientCreateInput = z.infer<typeof clientCreateSchema>
export type ClientUpdateInput = z.infer<typeof clientUpdateSchema>
export type ClientUserCreateInput = z.infer<typeof clientUserCreateSchema>
