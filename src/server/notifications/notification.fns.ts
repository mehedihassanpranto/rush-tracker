import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireUser } from '@/server/auth/guards.server'
import type { Notification } from '@/types/domain'

/** Recent notifications for the signed-in user (any role). For a CLIENT
 * user, scoped to whichever client is currently "active" (the same
 * cookie-backed selection requireClientMembership() uses) — a login
 * belonging to several clients only sees the one it's viewing, matching
 * every other portal page. Admin-facing notifications (client_id null)
 * never go through this filter. */
export const listMyNotificationsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ limit: z.number().int().min(1).max(100).optional() }))
  .handler(async ({ data }): Promise<Array<Notification>> => {
    const user = await requireUser()
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
    if (user.role === 'CLIENT' && user.activeClientId) {
      query = query.or(`client_id.is.null,client_id.eq.${user.activeClientId}`)
    }
    const { data: rows, error } = await query
      .order('created_at', { ascending: false })
      .limit(data.limit ?? 30)
    if (error) throw new Error(error.message)
    return rows as Array<Notification>
  })

/** Unread count for the header bell badge. */
export const unreadNotificationCountFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<{ count: number }> => {
  const user = await requireUser()
  const admin = getSupabaseAdminClient()
  const { count, error } = await admin
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .is('read_at', null)
  if (error) throw new Error(error.message)
  return { count: count ?? 0 }
})

/** Mark one of the user's own notifications read. */
export const markNotificationReadFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const user = await requireUser()
    const admin = getSupabaseAdminClient()
    const { error } = await admin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', data.id)
      .eq('user_id', user.id)
      .is('read_at', null)
    if (error) throw new Error(error.message)
    return { ok: true }
  })

/** Mark all of the user's unread notifications read. Scoped to the same
 * active-client filter as listMyNotificationsFn — otherwise "mark all
 * read" on a page showing only the active client's notifications would
 * silently clear unread ones from a client the user isn't even looking
 * at. */
export const markAllNotificationsReadFn = createServerFn({
  method: 'POST',
}).handler(async (): Promise<{ ok: true }> => {
  const user = await requireUser()
  const admin = getSupabaseAdminClient()
  let query = admin
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .is('read_at', null)
  if (user.role === 'CLIENT' && user.activeClientId) {
    query = query.or(`client_id.is.null,client_id.eq.${user.activeClientId}`)
  }
  const { error } = await query
  if (error) throw new Error(error.message)
  return { ok: true }
})
