import { z } from 'zod'

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app')

export const mfaVerifySchema = z.object({ code: totpCodeSchema })

export const mfaConfirmEnrollSchema = z.object({
  factor_id: z.uuid(),
  code: totpCodeSchema,
})

export const mfaRemoveSchema = z.object({ factor_id: z.uuid() })

export const mfaResetSchema = z.object({ user_id: z.uuid() })

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, 'Enter your current password'),
    new_password: z.string().min(8, 'At least 8 characters').max(72, 'At most 72 characters'),
  })
  .refine((v) => v.new_password !== v.current_password, {
    message: 'Choose a password different from the current one',
    path: ['new_password'],
  })

export const changeEmailSchema = z.object({
  new_email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('Enter a valid email address')),
  current_password: z.string().min(1, 'Enter your current password'),
})

/** The token from an email-change confirmation link (a hex hash, optionally
 * prefixed by Supabase). Shape-checked only — Supabase decides if it's valid. */
export const confirmEmailChangeSchema = z.object({
  token_hash: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/, 'Invalid link'),
})
