import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { refreshMetaSnapshots } from '@/server/meta/meta-snapshot.server'
import type { SnapshotRow } from '@/server/meta/meta-snapshot.server'

/**
 * The daily Meta spend reading for the platform's pool (Finance v2 Milestone
 * 3, migration 000063): refresh every pool account's figures from its own
 * Meta node, then let record_meta_spend_readings() post the change in
 * amount_spent since the last reading — or flag it, if it went down.
 *
 * Run by the meta-sync cron (once a day) and by "Read spend now" on the Meta
 * Accounts tab. Shared here, not in a .fns.ts, because the cron route needs it
 * too (CLAUDE.md: server helpers live in *.service.ts).
 */
export interface PoolSpendResult {
  refreshed: number
  failed: number
  posted: number
  spend_usd: string
  baselined: number
  flagged: number
}

export async function readPoolSpend(actorUserId: string | null): Promise<PoolSpendResult> {
  const admin = getSupabaseAdminClient()
  const { data, error } = await admin
    .from('ad_accounts')
    .select('id, name, external_account_id, is_platform, organization_id')
    .eq('is_platform', true)
    .not('external_account_id', 'is', null)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<SnapshotRow>
  const snap = rows.length > 0 ? await refreshMetaSnapshots(rows) : { refreshed: 0, failed: 0 }

  const { data: r, error: rpcErr } = await admin.rpc('record_meta_spend_readings', {
    p_actor: actorUserId,
  })
  if (rpcErr) throw new Error(rpcErr.message)
  const res = r as { posted: number; spend_usd: number; baselined: number; flagged: number }
  return {
    refreshed: snap.refreshed,
    failed: snap.failed,
    posted: res.posted,
    spend_usd: Number(res.spend_usd).toFixed(2),
    baselined: res.baselined,
    flagged: res.flagged,
  }
}
