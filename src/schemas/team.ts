import { z } from 'zod'
import { CLIENT_PERMISSION_KEYS } from '@/lib/permissions/client-permissions'

/** A portal login's access (000069): Owner, or a Member's permissions. */
export const portalAccessSchema = z.object({
  is_owner: z.boolean(),
  permissions: z.array(z.enum(CLIENT_PERMISSION_KEYS as unknown as [string, ...Array<string>])),
})

/** Adds a client-portal login for the caller's own client — same shape as
 * the admin's client-login creation, just client-initiated. */
export const addTeamMemberSchema = portalAccessSchema.extend({
  full_name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})

export const teamMemberAccessSchema = portalAccessSchema.extend({
  user_id: z.uuid(),
})

export const teamMemberStatusSchema = z.object({
  user_id: z.uuid(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
})

export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>
