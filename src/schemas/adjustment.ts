import { z } from 'zod'

const bdtAmount = z.coerce
  .number({ message: 'Enter a valid amount' })
  .positive('Must be greater than zero')
  .max(1_000_000_000, 'Amount is too large')

export const adjustmentCreateSchema = z.object({
  client_id: z.uuid('Select a client'),
  type: z.enum(['ADD_DUE', 'REDUCE_DUE']),
  amount_bdt: bdtAmount,
  reason: z.string().trim().min(1, 'A reason is required').max(1000),
  internal_note: z.string().trim().max(1000).optional(),
})

export const reverseSchema = z.object({
  ledger_id: z.uuid(),
  reason: z.string().trim().min(1, 'A reason is required').max(1000),
})

export type AdjustmentCreateInput = z.infer<typeof adjustmentCreateSchema>
