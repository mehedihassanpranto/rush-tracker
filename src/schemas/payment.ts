import { z } from 'zod'
import {
  ALLOWED_PROOF_MIME,
} from '@/schemas/limit-request'

const bdtAmount = z.coerce
  .number({ message: 'Enter a valid amount' })
  .positive('Must be greater than zero')
  .max(1_000_000_000, 'Amount is too large')

export const PAYMENT_METHODS = [
  'bKash',
  'Nagad',
  'Rocket',
  'Bank Transfer',
  'Card',
  'Cash',
  'Other',
] as const

// Client submits a payment WITH proof in one shot (spec §44 — proof required).
export const paymentSubmitSchema = z.object({
  amount_bdt: bdtAmount,
  payment_method: z.enum(PAYMENT_METHODS),
  transaction_reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
  payment_request_id: z.uuid().optional(),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.enum(ALLOWED_PROOF_MIME),
  data_base64: z.string().min(1),
})

export const paymentIdSchema = z.object({ id: z.uuid() })

export const paymentApproveSchema = z.object({
  id: z.uuid(),
  admin_note: z.string().trim().max(1000).optional(),
})

export const paymentRejectSchema = z.object({
  id: z.uuid(),
  rejection_reason: z.string().trim().min(1, 'A reason is required').max(1000),
})

export const paymentListSchema = z.object({
  status: z
    .enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL'])
    .default('PENDING'),
})

// Admin requests a payment from a client (spec §46).
export const paymentRequestCreateSchema = z.object({
  client_id: z.uuid('Select a client'),
  requested_amount_bdt: bdtAmount,
  message: z.string().trim().max(1000).optional(),
  due_date: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
})

export type PaymentSubmitInput = z.infer<typeof paymentSubmitSchema>
export type PaymentRequestCreateInput = z.infer<
  typeof paymentRequestCreateSchema
>
