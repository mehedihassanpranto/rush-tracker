import { z } from 'zod'

const optionalText = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v === '' ? undefined : v))

export const clientStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED'])

export const clientCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  company_name: optionalText,
  email: z
    .union([z.literal(''), z.email('Enter a valid email')])
    .optional()
    .transform((v) => (v ? v : undefined)),
  phone: optionalText,
  address: optionalText,
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
