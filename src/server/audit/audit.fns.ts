import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { PERMISSIONS } from '@/lib/permissions/permissions'

export interface AuditLogRow {
  id: string
  actor_user_id: string | null
  actor_name: string | null
  action: string
  entity_type: string
  entity_id: string | null
  created_at: string
}

const auditFilterSchema = z.object({
  action: z.string().optional(),
  entity_type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

/** Audit trail with filters (spec §55, §68). Admins with audit_logs.view. */
export const listAuditLogsFn = createServerFn({ method: 'GET' })
  .validator(auditFilterSchema)
  .handler(async ({ data }): Promise<Array<AuditLogRow>> => {
    await requireAdmin(PERMISSIONS.AUDIT_LOGS_VIEW)
    const admin = getSupabaseAdminClient()

    let query = admin
      .from('audit_logs')
      .select(
        'id, actor_user_id, action, entity_type, entity_id, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(data.limit ?? 200)
    if (data.action) query = query.eq('action', data.action)
    if (data.entity_type) query = query.eq('entity_type', data.entity_type)
    if (data.from) query = query.gte('created_at', data.from)
    if (data.to) query = query.lte('created_at', data.to)

    const { data: rows, error } = await query
    if (error) throw new Error(error.message)

    const logs = (rows ?? []) as Array<Omit<AuditLogRow, 'actor_name'>>

    // Resolve actor display names in one round-trip.
    const actorIds = [
      ...new Set(logs.map((l) => l.actor_user_id).filter(Boolean)),
    ] as Array<string>
    const nameById = new Map<string, string>()
    if (actorIds.length > 0) {
      const { data: profiles } = await admin
        .from('user_profiles')
        .select('user_id, full_name')
        .in('user_id', actorIds)
      for (const p of (profiles ?? []) as Array<{
        user_id: string
        full_name: string
      }>) {
        nameById.set(p.user_id, p.full_name)
      }
    }

    return logs.map((l) => ({
      ...l,
      actor_name: l.actor_user_id
        ? (nameById.get(l.actor_user_id) ?? null)
        : null,
    }))
  })

/** Distinct action + entity-type values, for the filter dropdowns. */
export const auditFilterOptionsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ actions: Array<string>; entityTypes: Array<string> }> => {
    await requireAdmin(PERMISSIONS.AUDIT_LOGS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data } = await admin
      .from('audit_logs')
      .select('action, entity_type')
      .order('created_at', { ascending: false })
      .limit(2000)
    const rows = (data ?? []) as Array<{ action: string; entity_type: string }>
    return {
      actions: [...new Set(rows.map((r) => r.action))].sort(),
      entityTypes: [...new Set(rows.map((r) => r.entity_type))].sort(),
    }
  },
)
