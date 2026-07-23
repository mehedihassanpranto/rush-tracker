import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'

export interface AuditEntry {
  actorUserId: string
  action: string
  entityType: string
  entityId?: string | null
  oldValues?: Record<string, unknown> | null
  newValues?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}

/**
 * Append an audit log entry (spec §55/§56). Best-effort for non-atomic CRUD:
 * failures are logged but never block the primary operation. Atomic RPCs write
 * their own audit rows inside the transaction instead.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const admin = getSupabaseAdminClient()
    await admin.from('audit_logs').insert({
      actor_user_id: entry.actorUserId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      old_values: entry.oldValues ?? null,
      new_values: entry.newValues ?? null,
      metadata: entry.metadata ?? null,
    })
  } catch (err) {
    console.error('[audit] failed to write entry', entry.action, err)
  }
}
