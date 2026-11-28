import { z } from 'zod'
import { ROLE_PERMISSION_KEYS } from '@/lib/permissions/agency-roles'

export const userStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED'])

/** A staff login's role: Super Admin, or one of the agency's own roles. */
const staffRoleChoice = z.union([z.literal('SUPER_ADMIN'), z.uuid()])

export const staffUserCreateSchema = z.object({
  full_name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
  role: staffRoleChoice,
})

export const setUserRoleSchema = z.object({
  user_id: z.uuid(),
  role: staffRoleChoice,
})

const rolePermissionKeyEnum = z.enum(
  ROLE_PERMISSION_KEYS as unknown as [string, ...Array<string>],
)

export const agencyRoleSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60, 'At most 60 characters'),
  description: z
    .string()
    .trim()
    .max(300, 'At most 300 characters')
    .optional()
    .transform((v) => (v ? v : null)),
  permissions: z.array(rolePermissionKeyEnum).min(1, 'Pick at least one permission'),
})

export const agencyRoleUpdateSchema = agencyRoleSchema.extend({ id: z.uuid() })

export const setUserStatusSchema = z.object({
  user_id: z.uuid(),
  status: userStatusEnum,
})

export type StaffUserCreateInput = z.infer<typeof staffUserCreateSchema>
export type SetUserRoleInput = z.infer<typeof setUserRoleSchema>
export type SetUserStatusInput = z.infer<typeof setUserStatusSchema>
export type AgencyRoleInput = z.input<typeof agencyRoleSchema>
