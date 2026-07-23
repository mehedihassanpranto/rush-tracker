import { z } from 'zod'
import { ALL_PERMISSION_KEYS } from '@/lib/permissions/permissions'

/** Roles that can be managed from the admin Users screen (staff only). */
export const staffRoleEnum = z.enum(['ADMIN', 'SUPER_ADMIN'])

export const userStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED'])

const permissionKeyEnum = z.enum(
  ALL_PERMISSION_KEYS as [string, ...Array<string>],
)

export const staffUserCreateSchema = z.object({
  full_name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
  role: staffRoleEnum.default('ADMIN'),
})

export const setUserRoleSchema = z.object({
  user_id: z.uuid(),
  role: staffRoleEnum,
})

export const setUserStatusSchema = z.object({
  user_id: z.uuid(),
  status: userStatusEnum,
})

export const setUserPermissionsSchema = z.object({
  user_id: z.uuid(),
  permissions: z.array(permissionKeyEnum),
})

export type StaffUserCreateInput = z.infer<typeof staffUserCreateSchema>
export type SetUserRoleInput = z.infer<typeof setUserRoleSchema>
export type SetUserStatusInput = z.infer<typeof setUserStatusSchema>
export type SetUserPermissionsInput = z.infer<typeof setUserPermissionsSchema>
