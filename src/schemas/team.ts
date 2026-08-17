import { z } from 'zod'

/** Adds a client-portal login for the caller's own client — same shape as
 * the admin's client-login creation, just client-initiated. */
export const addTeamMemberSchema = z.object({
  full_name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})

export const teamMemberStatusSchema = z.object({
  user_id: z.uuid(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
})

export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>
