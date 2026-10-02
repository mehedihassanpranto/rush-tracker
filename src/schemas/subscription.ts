import { z } from 'zod'
import { organizationId } from '@/schemas/organization'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

/** A limit field: blank = unlimited (null), otherwise a whole number ≥ 0. */
const limitField = z
  .union([z.literal(''), z.null(), z.coerce.number().int('Whole numbers only').min(0, 'Must be 0 or more').max(1_000_000)])
  .transform((v) => (v === '' || v === null ? null : v))

export const planUpsertSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, 'Name is required').max(60),
  monthly_fee_bdt: z.coerce
    .number({ message: 'Enter a valid amount' })
    .min(0, 'Must be 0 or more')
    .max(10_000_000, 'Amount is too large'),
  max_clients: limitField,
  max_ad_accounts: limitField,
  max_staff: limitField,
  is_active: z.boolean().default(true),
  sort_order: z.coerce.number().int().min(0).max(1000).default(0),
})
export type PlanUpsertInput = z.input<typeof planUpsertSchema>

export const setOrganizationPlanSchema = z.object({
  organization_id: organizationId,
  /** null = no plan (no limits). */
  plan_id: z.uuid().nullable(),
  billing_exempt: z.boolean(),
})

export const recordSubscriptionPaymentSchema = z
  .object({
    organization_id: organizationId,
    amount_bdt: z.coerce
      .number({ message: 'Enter a valid amount' })
      .positive('Must be greater than zero')
      .max(100_000_000, 'Amount is too large'),
    period_start: isoDate,
    period_end: isoDate,
    method: z.string().trim().max(60).optional(),
    reference: z.string().trim().max(200).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.period_end >= v.period_start, {
    message: 'Period end must be on or after the start',
    path: ['period_end'],
  })

export const subscriptionOrgSchema = z.object({ organization_id: organizationId })
