import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { getServerEnv } from '@/lib/env/env.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import {
  integrationSettingKeySchema,
  integrationSettingsUpdateSchema,
} from '@/schemas/settings'
import type {
  IntegrationSettingStatus,
  IntegrationSettings,
  SettingField,
} from './settings.fns'
import { SETTING_KEYS, maskToken } from './settings.fns'

/**
 * Platform panel — Rush Tracker's OWN Meta integration credentials, the ones
 * that reach the platform-owned ad account pool's Business Portfolio.
 *
 * Deliberately a separate module from settings.fns.ts (one agency's own
 * credentials) rather than a flag on those functions. The two are guarded
 * differently and must stay that way: these require `requirePlatformAdmin()`,
 * a cross-organization power that no agency admin holds, while the agency ones
 * require `requireAdmin(INTEGRATIONS_MANAGE)` and are scoped to the caller's
 * own organization. A single function branching on "am I the platform?" would
 * put both behind whichever guard ran first.
 *
 * Storage is `platform_settings` (migration 000037) — no organization_id at
 * all, so there is no id to get wrong and no way an agency-scoped query can
 * return these rows. The META_* env vars are this scope's fallback.
 */

export const getPlatformIntegrationSettingsFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<IntegrationSettings> => {
  await requirePlatformAdmin()
  const admin = getSupabaseAdminClient()
  const env = getServerEnv()

  const { data, error } = await admin
    .from('platform_settings')
    .select('key, value')
    .in('key', Object.values(SETTING_KEYS))
  if (error) throw new Error(error.message)
  const db = new Map(
    (data ?? []).map((r) => [r.key as string, r.value as string | null]),
  )

  // Unlike an agency, the platform DOES have an env fallback: META_* is set on
  // the deployment and points at the pool's portfolio.
  const envByField: Record<SettingField, string | undefined> = {
    meta_system_user_token: env.META_SYSTEM_USER_TOKEN,
    meta_business_id: env.META_BUSINESS_ID,
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

  return { fields, hasEnvFallback: true }
})

export const updatePlatformIntegrationSettingsFn = createServerFn({ method: 'POST' })
  .validator(integrationSettingsUpdateSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const updated: Array<SettingField> = []
    for (const field of Object.keys(SETTING_KEYS) as Array<SettingField>) {
      const value = data[field]
      // A blank field means "leave unchanged", never "clear it" — the real
      // value is never round-tripped to the browser to prefill the form, so a
      // blank submit must not be able to wipe a live credential. Clearing is
      // the separate, explicit action below.
      if (!value) continue
      const { error } = await admin
        .from('platform_settings')
        .upsert({ key: SETTING_KEYS[field], value, updated_by: actor.id }, {
          onConflict: 'key',
        })
      if (error) throw new Error(error.message)
      updated.push(field)
    }
    if (updated.length === 0) {
      throw new Error('Nothing to update')
    }

    // audit_logs.organization_id is NOT NULL and the platform is not an
    // organization, so the row lands in the acting platform admin's own —
    // the same convention deleteOrganizationFn uses for offboarding. Never the
    // raw secret value, only which fields changed.
    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'PLATFORM_INTEGRATION_SETTINGS_UPDATED',
      entityType: 'PLATFORM_SETTINGS',
      entityId: null,
      newValues: { fields_updated: updated },
    })
    return { ok: true }
  })

/** Deletes a field's DB override, reverting it to the META_* env var. */
export const clearPlatformIntegrationSettingFn = createServerFn({ method: 'POST' })
  .validator(integrationSettingKeySchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    const { error } = await admin
      .from('platform_settings')
      .delete()
      .eq('key', SETTING_KEYS[data.field])
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'PLATFORM_INTEGRATION_SETTINGS_CLEARED',
      entityType: 'PLATFORM_SETTINGS',
      entityId: null,
      newValues: { field: data.field },
    })
    return { ok: true }
  })
