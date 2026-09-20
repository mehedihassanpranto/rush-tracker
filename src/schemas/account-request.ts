import { z } from 'zod'

export const accountRequestCreateSchema = z.object({
  notes: z
    .string()
    .trim()
    .min(1, 'Tell the platform what the account is for')
    .max(1000, 'Keep it under 1,000 characters'),
})
export type AccountRequestCreateInput = z.infer<typeof accountRequestCreateSchema>

export const accountRequestIdSchema = z.object({ id: z.uuid() })

export const accountRequestFulfillSchema = z.object({
  id: z.uuid(),
  ad_account_id: z.uuid(),
})
export type AccountRequestFulfillInput = z.infer<typeof accountRequestFulfillSchema>

export const accountRequestRejectSchema = z.object({
  id: z.uuid(),
  reason: z
    .string()
    .trim()
    .min(1, 'A reason is required — the agency sees it')
    .max(500, 'Keep it under 500 characters'),
})
export type AccountRequestRejectInput = z.infer<typeof accountRequestRejectSchema>

export const accountRequestListSchema = z.object({
  status: z.enum(['PENDING', 'FULFILLED', 'REJECTED', 'CANCELLED', 'ALL']).default('PENDING'),
})
