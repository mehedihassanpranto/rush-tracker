import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireUser } from '@/server/auth/guards.server'
import type { Notification } from '@/types/domain'

/** Recent notifications for the signed-in user (any role). */
export const listMyNotificationsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ limit: z.number().int().min(1).max(100).optional() }))
  .handler(async ({ data }): Promise<Array<Notification>> => {
    const user = await requireUser()
    const admin = getSupabaseAdminClient()
    const { data: rows, error } = await admin
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
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

/** Mark all of the user's unread notifications read. */
export const markAllNotificationsReadFn = createServerFn({
  method: 'POST',
}).handler(async (): Promise<{ ok: true }> => {
  const user = await requireUser()
  const admin = getSupabaseAdminClient()
  const { error } = await admin
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .is('read_at', null)
  if (error) throw new Error(error.message)
  return { ok: true }
})
