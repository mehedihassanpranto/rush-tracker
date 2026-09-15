/**
 * Which set of Meta credentials a settings screen is editing.
 *
 * 'agency'   — one agency's own Business Portfolio (`app_settings`, keyed by
 *              organization). Shown on /agency/settings.
 * 'platform' — Rush Tracker's own portfolio, the one holding the platform-owned
 *              ad account pool (`platform_settings`). Shown on
 *              /platform/settings, reachable only by a platform admin.
 *
 * The two are separate rows in separate tables behind separate guards; this
 * type only decides which pair of endpoints the shared card talks to.
 */
export type IntegrationScope = 'agency' | 'platform'

/** Separate cache keys so one scope's values can never be served for the
 * other — a platform admin who also holds an agency role would otherwise see
 * whichever loaded first. */
export const SETTINGS_QUERY_KEY: Record<IntegrationScope, string> = {
  agency: 'integration-settings',
  platform: 'platform-integration-settings',
}
