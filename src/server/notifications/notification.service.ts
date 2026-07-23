import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'

/**
 * In-app notification creation (spec §54). Best-effort, like writeAudit:
 * notifications are fired AFTER a successful transaction (spec §53 note —
 * notification creation may occur outside the DB transaction) and must never
 * block or roll back the primary operation. V1 has no external providers.
 */

export interface NotifyInput {
  userIds: Array<string>
  type: string
  title: string
  message?: string | null
  entityType?: string | null
  entityId?: string | null
}

/** Insert one notification row per recipient user. */
export async function notify(input: NotifyInput): Promise<void> {
  const recipients = [...new Set(input.userIds)].filter(Boolean)
  if (recipients.length === 0) return
  try {
    const admin = getSupabaseAdminClient()
    const rows = recipients.map((userId) => ({
      user_id: userId,
      type: input.type,
      title: input.title,
      message: input.message ?? null,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
    }))
    await admin.from('notifications').insert(rows)
  } catch (err) {
    console.error('[notify] failed to write notifications', input.type, err)
  }
}

/** Recipient ids: all ACTIVE admin/super-admin users. */
async function adminUserIds(): Promise<Array<string>> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('user_profiles')
    .select('user_id, status, role:roles(key)')
    .eq('status', 'ACTIVE')
  return ((data ?? []) as unknown as Array<{
    user_id: string
    role: { key: string } | null
  }>)
    .filter((u) => u.role?.key === 'ADMIN' || u.role?.key === 'SUPER_ADMIN')
    .map((u) => u.user_id)
}

/** Recipient ids: all ACTIVE members of a client. */
async function clientMemberUserIds(clientId: string): Promise<Array<string>> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('client_memberships')
    .select('user_id')
    .eq('client_id', clientId)
    .eq('status', 'ACTIVE')
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)
}

/** Notify every active admin (e.g. a client submitted a request/payment). */
export async function notifyAdmins(
  input: Omit<NotifyInput, 'userIds'>,
): Promise<void> {
  await notify({ ...input, userIds: await adminUserIds() })
}

/** Notify every active member of a client (e.g. an approval/rejection). */
export async function notifyClientMembers(
  clientId: string,
  input: Omit<NotifyInput, 'userIds'>,
): Promise<void> {
  await notify({ ...input, userIds: await clientMemberUserIds(clientId) })
}
