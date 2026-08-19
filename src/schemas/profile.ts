import { z } from 'zod'

/** Client-portal self-service profile edit — name only (email changes need
 * a re-verification flow and are out of scope here). */
export const myProfileUpdateSchema = z.object({
  full_name: z.string().trim().min(1, 'Name is required').max(200),
})

export type MyProfileUpdateInput = z.infer<typeof myProfileUpdateSchema>
