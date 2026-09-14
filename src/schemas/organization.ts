import { z } from 'zod'

export const organizationSubscriptionStatusEnum = z.enum([
  'active',
  'suspended',
  'cancelled',
])

/**
 * Org zero's id is the hand-picked sentinel `00000000-0000-0000-0000-000000000001`
 * (see the multi-tenant migration) — not a real RFC 4122 UUID (its version
 * nibble is 0, not 1-8), so Zod v4's strict `z.uuid()` rejects it outright.
 * Validates the general 8-4-4-4-12 hex shape instead, accepting both org
 * zero's sentinel and any real gen_random_uuid()-generated id.
 */
const organizationId = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'Invalid organization id',
  )

export const organizationUpdateSchema = z.object({
  id: organizationId,
  name: z.string().trim().min(1, 'Name is required').max(200),
  plan: z
    .union([z.literal(''), z.string().trim().max(100)])
    .optional()
    .transform((v) => (v ? v : undefined)),
  notes: z
    .union([z.literal(''), z.string().trim().max(5000)])
    .optional()
    .transform((v) => (v ? v : undefined)),
})

export const organizationStatusSchema = z.object({
  id: organizationId,
  subscription_status: organizationSubscriptionStatusEnum,
})

export type OrganizationUpdateInput = z.infer<typeof organizationUpdateSchema>
export type OrganizationStatusInput = z.infer<typeof organizationStatusSchema>
