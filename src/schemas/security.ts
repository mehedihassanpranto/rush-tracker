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
