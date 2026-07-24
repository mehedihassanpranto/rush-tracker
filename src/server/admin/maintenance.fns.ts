import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Exact phrase the caller must type to confirm the wipe. */
export const RESET_CONFIRM_PHRASE = 'DELETE ALL DATA'

/** A uuid no real row will ever have — lets us match "all rows" for a delete. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Business/transactional tables in FK-safe delete order (children first).
 * user_profiles / roles / permissions are intentionally excluded so admin
 * logins and configuration survive.
 */
const WIPE_ORDER = [
  'notifications',
  'audit_logs',
  'adjustments',
  'ledger_entries',
  'payments',
  'payment_requests',
  'limit_requests',
  'ad_account_assignments',
  'attachments',
  'ad_accounts',
  'client_memberships',
  'clients',
  'exchange_rates',
] as const

/** Delete every row of each business table (no custom DB function required). */
async function directWipe(admin: SupabaseClient): Promise<void> {
  for (const table of WIPE_ORDER) {
    const { error } = await admin.from(table).delete().neq('id', NIL_UUID)
    if (error) throw new Error(`Failed clearing ${table}: ${error.message}`)
  }

  // Delete every CLIENT login (cascades their profile + memberships).
  const { data: roleRow } = await admin
    .from('roles')
    .select('id')
    .eq('key', 'CLIENT')
    .maybeSingle()
  const clientRoleId = (roleRow as { id: string } | null)?.id
  if (clientRoleId) {
    const { data: clientProfiles } = await admin
      .from('user_profiles')
      .select('user_id')
      .eq('role_id', clientRoleId)
    for (const p of (clientProfiles ?? []) as Array<{ user_id: string }>) {
      await admin.auth.admin.deleteUser(p.user_id)
    }
  }
}

/** Recursively collect and remove every object in a storage bucket. */
async function emptyBucket(
  admin: SupabaseClient,
  bucket: string,
): Promise<void> {
  async function walk(prefix: string): Promise<Array<string>> {
    const { data } = await admin.storage
      .from(bucket)
      .list(prefix, { limit: 1000 })
    const paths: Array<string> = []
    for (const item of data ?? []) {
      const full = prefix ? `${prefix}/${item.name}` : item.name
      // Supabase marks folders with a null id; files carry an id.
      if ((item as { id: string | null }).id) paths.push(full)
      else paths.push(...(await walk(full)))
    }
    return paths
  }
  const all = await walk('')
  for (let i = 0; i < all.length; i += 1000) {
    await admin.storage.from(bucket).remove(all.slice(i, i + 1000))
  }
}

/**
 * Clear ALL business data and every client login (Settings → Danger Zone).
 * SUPER_ADMIN only + exact confirmation phrase. Irreversible.
 *
 * Prefers the atomic `reset_all_data()` RPC (which also restarts the document-
 * number counters); if that function isn't installed, falls back to a direct
 * row-by-row wipe so the button always works. Proof files are then removed
 * from storage via the Storage API.
 */
export const resetAllDataFn = createServerFn({ method: 'POST' })
  .validator(z.object({ confirm: z.string() }))
  .handler(async ({ data }): Promise<{ ok: true; countersReset: boolean }> => {
    const actor = await requireAdmin()
    if (actor.role !== 'SUPER_ADMIN') {
      throw new Error('Only a Super Admin can clear all data')
    }
    if (data.confirm !== RESET_CONFIRM_PHRASE) {
      throw new Error(`Type "${RESET_CONFIRM_PHRASE}" exactly to confirm`)
    }

    const admin = getSupabaseAdminClient()

    // Prefer the atomic RPC (also resets the CL-/PAY-/… counters).
    const rpc = await admin.rpc('reset_all_data')
    let countersReset = true
    if (rpc.error) {
      // Function not installed / schema cache stale — wipe directly instead.
      countersReset = false
      await directWipe(admin)
    }

    // Best-effort: remove the now-orphaned proof files from storage.
    try {
      await emptyBucket(admin, 'proofs')
    } catch (err) {
      console.error('[reset] failed to empty proofs bucket', err)
    }

    return { ok: true, countersReset }
  })
