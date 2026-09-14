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
  /** Which client this notification is about, when known — only
   * notifyClientMembers() ever sets this. Lets a login belonging to
   * several clients filter its notification list to the one it's
   * currently viewing (see requireClientMembership()'s active-client
   * cookie); left null for admin-facing notifications, which are never
   * filtered. */
  clientId?: string | null
  /** The organization every recipient (and the notification row itself)
   * belongs to. Required — notifications.organization_id is NOT NULL. */
  organizationId: string
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
      client_id: input.clientId ?? null,
      organization_id: input.organizationId,
    }))
    await admin.from('notifications').insert(rows)
  } catch (err) {
    console.error('[notify] failed to write notifications', input.type, err)
  }
}

/** Recipient ids: all ACTIVE admin/super-admin users OF THIS ORGANIZATION.
 * Without the organization_id filter, every admin across every subscribing
 * agency would be notified about every other agency's activity — this was
 * a real cross-tenant leak found and fixed as part of the multi-tenant
 * conversion, not a pre-existing requirement. */
async function adminUserIds(organizationId: string): Promise<Array<string>> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('user_profiles')
    .select('user_id, status, role:roles(key)')
    .eq('status', 'ACTIVE')
    .eq('organization_id', organizationId)
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

/** Notify every active admin of one organization (e.g. a client submitted a
 * request/payment) — organizationId is required, never inferred, since
 * there's no client/account context to derive it from at every call site. */
export async function notifyAdmins(
  input: Omit<NotifyInput, 'userIds'>,
): Promise<void> {
  await notify({ ...input, userIds: await adminUserIds(input.organizationId) })
}

/** Notify every active member of a client (e.g. an approval/rejection).
 * organizationId is resolved from the client row itself — clientId already
 * uniquely determines it, so every call site doesn't need to also thread
 * one through (and can't accidentally pass a mismatched one). */
export async function notifyClientMembers(
  clientId: string,
  input: Omit<NotifyInput, 'userIds' | 'clientId' | 'organizationId'>,
): Promise<void> {
  const admin = getSupabaseAdminClient()
  const { data: client } = await admin
    .from('clients')
    .select('organization_id')
    .eq('id', clientId)
    .maybeSingle()
  if (!client) {
    console.error('[notifyClientMembers] client not found, skipping', clientId)
    return
  }
  await notify({
    ...input,
    userIds: await clientMemberUserIds(clientId),
    clientId,
    organizationId: (client as { organization_id: string }).organization_id,
  })
}
