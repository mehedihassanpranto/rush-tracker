import { z } from 'zod'

/** All fields optional: a blank field means "leave unchanged" — the
 * current token value is never round-tripped to the browser to prefill,
 * so a blank submit must never accidentally clear it.
 *
 * meta_business_id and meta_api_version are format-validated on top of
 * that, deliberately — not for data quality, but as a hard backstop
 * against browser autofill. Browsers routinely ignore `autocomplete="off"`
 * and fill a random saved value (a saved email, in one observed case) into
 * whatever text field is near a password field; a shape check that a real
 * Meta value would always pass and unrelated autofilled text would almost
 * always fail catches that before it can silently overwrite a working
 * credential. */
export const integrationSettingsUpdateSchema = z.object({
  // Each field: key may be absent entirely (the server payload only ever
  // includes fields that were actually changed) OR present as '' (the
  // form's default/untouched state) OR present as a real, format-valid
  // value. A bare `.min(1).optional()` would reject '' outright — .optional()
  // only skips validation for `undefined`, not an empty string — which
  // would have blocked submitting the form with any field left blank.
  meta_system_user_token: z.union([z.literal(''), z.string().trim().min(1)]).optional(),
  meta_business_id: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^\d+$/, 'Must be numeric — Meta Business Portfolio IDs are digits only'),
    ])
    .optional(),
  meta_api_version: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^v\d+(\.\d+)?$/, 'Must look like a Meta API version, e.g. v21.0'),
    ])
    .optional(),
})

export type IntegrationSettingsUpdateInput = z.infer<
  typeof integrationSettingsUpdateSchema
>

export const integrationSettingKeySchema = z.object({
  field: z.enum(['meta_system_user_token', 'meta_business_id', 'meta_api_version']),
})

export type IntegrationSettingKeyInput = z.infer<typeof integrationSettingKeySchema>
