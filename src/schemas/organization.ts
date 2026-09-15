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
export const organizationId = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'Invalid organization id',
  )

export const organizationIdSchema = z.object({ id: organizationId })

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

/**
 * Onboarding a new subscribing agency: the organization and its first
 * SUPER_ADMIN login are created together, because an organization with no
 * way to log into it is useless and an admin with no organization lands in
 * org zero (the signup trigger's default).
 */
export const organizationCreateSchema = z.object({
  name: z.string().trim().min(1, 'Agency name is required').max(200),
  plan: z
    .union([z.literal(''), z.string().trim().max(100)])
    .optional()
    .transform((v) => (v ? v : undefined)),
  notes: z
    .union([z.literal(''), z.string().trim().max(5000)])
    .optional()
    .transform((v) => (v ? v : undefined)),
  admin_full_name: z.string().trim().min(1, "The admin's name is required").max(200),
  admin_email: z.email('Enter a valid email address'),
  admin_password: z.string().min(8, 'Use at least 8 characters'),
})

/**
 * Adding a Super Admin login to an organization that already exists — the
 * bootstrap path for an agency created without one, or one that has lost
 * access to every admin account it had.
 */
export const organizationAdminCreateSchema = z.object({
  organization_id: organizationId,
  full_name: z.string().trim().min(1, "The admin's name is required").max(200),
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters'),
})

/** One admin inside one organization. Both ids are always supplied together
 * and the update is scoped to the pair, so a stale or hand-edited request
 * can't reach an admin in a different agency. */
export const organizationAdminRefSchema = z.object({
  organization_id: organizationId,
  user_id: z.uuid(),
})

export const organizationAdminStatusSchema = organizationAdminRefSchema.extend({
  status: z.enum(['ACTIVE', 'INACTIVE']),
})

/**
 * Permanently offboarding an agency. `confirm_name` must match the
 * organization's name exactly — a fixed phrase (the convention used by "Clear
 * all data") is too easy to paste at the wrong agency when the screen looks
 * identical for every one of them.
 */
export const organizationDeleteSchema = z.object({
  id: organizationId,
  confirm_name: z.string().min(1),
})

export type OrganizationDeleteInput = z.infer<typeof organizationDeleteSchema>

export type OrganizationCreateInput = z.infer<typeof organizationCreateSchema>
export type OrganizationAdminCreateInput = z.infer<
  typeof organizationAdminCreateSchema
>

export type OrganizationUpdateInput = z.infer<typeof organizationUpdateSchema>
export type OrganizationStatusInput = z.infer<typeof organizationStatusSchema>
