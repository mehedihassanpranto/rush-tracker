import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Exact phrase the caller must type to confirm the wipe. */
export const RESET_CONFIRM_PHRASE = 'DELETE ALL DATA'

/**
 * Business/transactional tables in FK-safe delete order (children first).
 * user_profiles / roles / permissions are intentionally excluded so admin
 * logins survive; exchange_rates is excluded so the configured USD rate (needed
 * for billing + USD display) survives a reset. client_employees/employees
 * are included to match reset_all_data()'s RPC behavior — this JS fallback
 * had drifted out of sync with it (a real, pre-existing gap found and fixed
 * incidentally while adding organization scoping below).
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
  'client_employees',
  'employees',
  'client_memberships',
  'clients',
] as const

/**
 * Delete every row of each business table, scoped to one organization (no
 * custom DB function required). This is the fallback path used when
 * reset_all_data() isn't installed — it must apply the exact same
 * organization scoping the RPC does. Without it, this fallback would wipe
 * every subscribing organization's data, not just the caller's own: it was
 * found doing exactly that (matching `.neq('id', NIL_UUID)` against every
 * row in every table, no organization filter at all) while adding
 * multi-tenant scoping elsewhere — a real bug, not a hypothetical.
 */
async function directWipe(
  admin: SupabaseClient,
  organizationId: string,
): Promise<void> {
  for (const table of WIPE_ORDER) {
    const { error } = await admin
      .from(table)
      .delete()
      .eq('organization_id', organizationId)
    if (error) throw new Error(`Failed clearing ${table}: ${error.message}`)
  }

  // Delete every CLIENT login belonging to THIS organization (cascades
  // their profile + memberships).
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
      .eq('organization_id', organizationId)
    for (const p of (clientProfiles ?? []) as Array<{ user_id: string }>) {
      await admin.auth.admin.deleteUser(p.user_id)
    }
  }
}

/**
 * Remove only this organization's proof files from the shared `proofs`
 * bucket — never the whole bucket (previously `emptyBucket()` walked and
 * removed every object regardless of which organization it belonged to, a
 * cross-tenant data-destruction bug matching the one fixed in directWipe()
 * above). storage_path is captured from `attachments` BEFORE that table's
 * rows are deleted, since organization_id lives on the row, not derivable
 * from the path alone.
 */
async function removeOrgProofFiles(
  admin: SupabaseClient,
  bucket: string,
  paths: Array<string>,
): Promise<void> {
  for (let i = 0; i < paths.length; i += 1000) {
    await admin.storage.from(bucket).remove(paths.slice(i, i + 1000))
  }
}

/**
 * Clear ALL business data and every client login (Settings → Danger Zone).
 * SUPER_ADMIN only + exact confirmation phrase. Irreversible.
 *
 * Prefers the atomic `reset_all_data()` RPC; if that function isn't
 * installed, falls back to a direct row-by-row wipe so the button always
 * works. Proof files are then removed from storage via the Storage API.
 *
 * Document-number counters (CL-/ADA-/… sequences) are NEVER reset by either
 * path, as of the multi-tenant conversion — they're shared across every
 * organization, so resetting them because one organization cleared their
 * own data would renumber/collide codes for every other still-live
 * organization. `countersReset` always reports false now; kept in the
 * response shape rather than removed so the UI's existing two-message
 * copy (see reset-data-dialog.tsx) still renders correctly without a
 * matching UI change.
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
    const organizationId = actor.organizationId

    // Capture this organization's proof file paths BEFORE any rows are
    // deleted — organization_id lives on the attachments row, not the
    // storage path itself, so this must happen first.
    const { data: attachmentRows } = await admin
      .from('attachments')
      .select('storage_path')
      .eq('organization_id', organizationId)
      .eq('storage_bucket', 'proofs')
    const proofPaths = ((attachmentRows ?? []) as Array<{ storage_path: string }>).map(
      (r) => r.storage_path,
    )

    // Prefer the atomic RPC.
    const rpc = await admin.rpc('reset_all_data', { p_organization_id: organizationId })
    if (rpc.error) {
      // Function not installed / schema cache stale — wipe directly instead.
      await directWipe(admin, organizationId)
    }
    const countersReset = false

    // Best-effort: remove this organization's now-orphaned proof files from
    // storage — never the whole shared bucket.
    try {
      await removeOrgProofFiles(admin, 'proofs', proofPaths)
    } catch (err) {
      console.error('[reset] failed to remove proof files', err)
    }

    return { ok: true, countersReset }
  })
