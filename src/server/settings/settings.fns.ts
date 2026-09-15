import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { getServerEnv } from '@/lib/env/env.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  integrationSettingKeySchema,
  integrationSettingsUpdateSchema,
} from '@/schemas/settings'

/**
 * Admin Settings screen — ONE AGENCY's own Meta integration credentials,
 * stored in `app_settings` (DB-backed) rather than env vars, since env vars
 * can't be live-updated from application code on Vercel (baked in per
 * deployment). See src/server/meta/meta.server.ts's getMetaConfig().
 *
 * **There is no credential env fallback here, for any agency including org
 * zero.** The META_* env vars are the PLATFORM's credentials (they point at
 * the portfolio holding the platform-owned account pool) and are managed from
 * the platform panel — see platform-settings.fns.ts. An agency has a Meta
 * integration only if it connected its own Business Portfolio. Reintroducing
 * a fallback here would hand an agency a token for a portfolio it does not
 * own, and let its Settings screen rotate the platform's credentials.
 *
 * The raw token is never sent back to the browser once saved — only a
 * masked preview (last 4 chars). A blank field on save means "leave this
 * one unchanged," never "clear it" (clearing is a separate explicit action)
 * — this is what makes it safe that the real value is never prefilled into
 * the edit form.
 */

/** Shared with platform-settings.fns.ts — the same three keys are stored per
 * agency in `app_settings` and once for the platform in `platform_settings`. */
export const SETTING_KEYS = {
  meta_system_user_token: 'META_SYSTEM_USER_TOKEN',
  meta_business_id: 'META_BUSINESS_ID',
  meta_api_version: 'META_API_VERSION',
} as const

export type SettingField = keyof typeof SETTING_KEYS

export interface IntegrationSettingStatus {
  field: SettingField
  configured: boolean
  source: 'database' | 'env' | 'unset'
  /** Masked (last 4 chars) for the token; plain value for the others —
   * business id / API version aren't credentials, just identifiers. */
  preview: string | null
}

export function maskToken(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`
}

export interface IntegrationSettings {
  fields: Array<IntegrationSettingStatus>
  /** Whether this scope's credentials have an env-var fallback behind them.
   * True only for the platform scope; every agency's credentials live purely
   * in the database, so "overrides the environment variables" would be
   * meaningless (and misleading) copy for them. */
  hasEnvFallback: boolean
}

export const getIntegrationSettingsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<IntegrationSettings> => {
    const actor = await requireAdmin(PERMISSIONS.INTEGRATIONS_MANAGE)
    const admin = getSupabaseAdminClient()
    const env = getServerEnv()

    const { data, error } = await admin
      .from('app_settings')
      .select('key, value')
      .eq('organization_id', actor.organizationId)
      .in('key', Object.values(SETTING_KEYS))
    if (error) throw new Error(error.message)
    const db = new Map(
      (data ?? []).map((r) => [r.key as string, r.value as string | null]),
    )

    // The META_* credentials in the environment belong to the PLATFORM, not
    // to any agency — see getMetaConfig(). Showing them as an agency's
    // "current value" would be a lie about whose portfolio is connected, and
    // offering to clear back to them would be worse. The API version isn't a
    // credential, just a protocol version, so the deployment default is shown
    // to everyone.
    const envByField: Record<SettingField, string | undefined> = {
      meta_system_user_token: undefined,
      meta_business_id: undefined,
      meta_api_version: env.META_API_VERSION,
    }

    const fields = (Object.keys(SETTING_KEYS) as Array<SettingField>).map((field) => {
      const dbValue = db.get(SETTING_KEYS[field])
      const envValue = envByField[field]
      const preview = (value: string) =>
        field === 'meta_system_user_token' ? maskToken(value) : value

      if (dbValue)
        return { field, configured: true, source: 'database', preview: preview(dbValue) }
      if (envValue)
        return { field, configured: true, source: 'env', preview: preview(envValue) }
      return { field, configured: false, source: 'unset', preview: null }
    }) as Array<IntegrationSettingStatus>

    return { fields, hasEnvFallback: false }
  },
)

export const updateIntegrationSettingsFn = createServerFn({ method: 'POST' })
  .validator(integrationSettingsUpdateSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.INTEGRATIONS_MANAGE)
    const admin = getSupabaseAdminClient()

    const updated: Array<SettingField> = []
    for (const field of Object.keys(SETTING_KEYS) as Array<SettingField>) {
      const value = data[field]
      if (!value) continue
      const { error } = await admin
        .from('app_settings')
        .upsert(
          {
            organization_id: actor.organizationId,
            key: SETTING_KEYS[field],
            value,
            updated_by: actor.id,
          },
          { onConflict: 'organization_id,key' },
        )
      if (error) throw new Error(error.message)
      updated.push(field)
    }
    if (updated.length === 0) {
      throw new Error('Nothing to update')
    }

    // Never write the raw secret value into the audit trail — only which
    // fields changed.
    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'INTEGRATION_SETTINGS_UPDATED',
      entityType: 'APP_SETTINGS',
      entityId: null,
      newValues: { fields_updated: updated },
    })
    return { ok: true }
  })

/** Deletes a field's DB override, reverting it to the env var fallback. */
export const clearIntegrationSettingFn = createServerFn({ method: 'POST' })
  .validator(integrationSettingKeySchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin(PERMISSIONS.INTEGRATIONS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { error } = await admin
      .from('app_settings')
      .delete()
      .eq('organization_id', actor.organizationId)
      .eq('key', SETTING_KEYS[data.field])
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'INTEGRATION_SETTINGS_CLEARED',
      entityType: 'APP_SETTINGS',
      entityId: null,
      newValues: { field: data.field },
    })
    return { ok: true }
  })
