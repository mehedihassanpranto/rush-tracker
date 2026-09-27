import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'

/**
 * Platform Management → Notifications: browse `notification_events` (every
 * Telegram send attempt, not just successes) and see who's actually
 * connected. Read-only — connecting/disconnecting stays in each portal's own
 * Settings page, never here.
 */

export interface NotificationLogSummary {
  total_connected: number
  by_recipient_type: Record<'platform_admin' | 'agency' | 'client', number>
}

export const getNotificationLogSummaryFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<NotificationLogSummary> => {
    await requirePlatformAdmin()
    const { data } = await getSupabaseAdminClient()
      .from('telegram_subscriptions')
      .select('recipient_type')
      .eq('is_active', true)
    const rows = (data ?? []) as Array<{
      recipient_type: 'platform_admin' | 'agency' | 'client'
    }>
    const byType = { platform_admin: 0, agency: 0, client: 0 }
    for (const r of rows) byType[r.recipient_type]++
    return { total_connected: rows.length, by_recipient_type: byType }
  },
)

const STATUS_VALUES = [
  'sent',
  'failed',
  'skipped_no_subscription',
  'skipped_preference_off',
  'ALL',
] as const

const listSchema = z.object({
  status: z.enum(STATUS_VALUES).default('ALL'),
  event_type: z.string().optional(),
})

export interface NotificationLogRow {
  id: string
  event_type: string
  recipient_type: 'platform_admin' | 'agency' | 'client'
  recipient_id: string
  recipient_name: string | null
  status: string
  error: string | null
  created_at: string
  sent_at: string | null
}

export const listNotificationEventsFn = createServerFn({ method: 'GET' })
  .validator(listSchema)
  .handler(async ({ data }): Promise<Array<NotificationLogRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()

    let query = admin
      .from('notification_events')
      .select(
        'id, event_type, recipient_type, recipient_id, status, telegram_response, created_at, sent_at',
      )
      .order('created_at', { ascending: false })
      .limit(200)
    if (data.status !== 'ALL') query = query.eq('status', data.status)
    if (data.event_type) query = query.eq('event_type', data.event_type)

    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    const events = (rows ?? []) as Array<{
      id: string
      event_type: string
      recipient_type: 'platform_admin' | 'agency' | 'client'
      recipient_id: string
      status: string
      telegram_response: { description?: string } | null
      created_at: string
      sent_at: string | null
    }>

    // Two batched lookups for friendly names, never one query per row.
    const orgIds = [
      ...new Set(events.filter((e) => e.recipient_type === 'agency').map((e) => e.recipient_id)),
    ]
    const clientIds = [
      ...new Set(events.filter((e) => e.recipient_type === 'client').map((e) => e.recipient_id)),
    ]
    const [{ data: orgs }, { data: clients }] = await Promise.all([
      orgIds.length > 0
        ? admin.from('organizations').select('id, name').in('id', orgIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
      clientIds.length > 0
        ? admin.from('clients').select('id, name').in('id', clientIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    ])
    const orgNames = new Map(
      ((orgs ?? []) as Array<{ id: string; name: string }>).map((o) => [o.id, o.name]),
    )
    const clientNames = new Map(
      ((clients ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
    )

    return events.map((e) => ({
      id: e.id,
      event_type: e.event_type,
      recipient_type: e.recipient_type,
      recipient_id: e.recipient_id,
      recipient_name:
        e.recipient_type === 'agency'
          ? orgNames.get(e.recipient_id) ?? null
          : e.recipient_type === 'client'
            ? clientNames.get(e.recipient_id) ?? null
            : 'Platform admins',
      status: e.status,
      error: e.telegram_response?.description ?? null,
      created_at: e.created_at,
      sent_at: e.sent_at,
    }))
  })
