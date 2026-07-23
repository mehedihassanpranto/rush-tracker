import { z } from 'zod'

const usdAmount = z.coerce
  .number({ message: 'Enter a valid amount' })
  .positive('Must be greater than zero')
  .max(1_000_000_000, 'Amount is too large')

const usdRate = z.coerce
  .number({ message: 'Enter a valid rate' })
  .positive('Must be greater than zero')
  .max(100_000, 'Rate is too large')

// Client creates a request for one of their active accounts (spec §21).
export const limitRequestCreateSchema = z.object({
  ad_account_id: z.uuid('Select an account'),
  requested_amount_usd: usdAmount,
})

export const limitRequestIdSchema = z.object({
  id: z.uuid(),
})

// Admin approval (spec §25) — approved amount and rate are both editable.
export const limitApproveSchema = z.object({
  id: z.uuid(),
  approved_amount_usd: usdAmount,
  approved_usd_rate: usdRate,
  admin_note: z.string().trim().max(1000).optional(),
})

export const limitRejectSchema = z.object({
  id: z.uuid(),
  rejection_reason: z.string().trim().min(1, 'A reason is required').max(1000),
})

export const limitRequestListSchema = z.object({
  status: z
    .enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL'])
    .default('PENDING'),
})

// Proof upload: file delivered as base64 (spec §29, §53). Small screenshots.
export const ALLOWED_PROOF_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

export const MAX_PROOF_BYTES = 3 * 1024 * 1024 // 3 MB (base64-safe for serverless)

export const proofUploadSchema = z.object({
  request_id: z.uuid(),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.enum(ALLOWED_PROOF_MIME),
  data_base64: z.string().min(1),
})

export const setDefaultRateSchema = z.object({
  rate: usdRate,
})

export type LimitRequestCreateInput = z.infer<typeof limitRequestCreateSchema>
export type LimitApproveInput = z.infer<typeof limitApproveSchema>
export type LimitRejectInput = z.infer<typeof limitRejectSchema>
