import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Exact phrase the caller must type to confirm the wipe. */
export const RESET_CONFIRM_PHRASE = 'DELETE ALL DATA'

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
  // remove() takes up to 1000 paths per call.
  for (let i = 0; i < all.length; i += 1000) {
    await admin.storage.from(bucket).remove(all.slice(i, i + 1000))
  }
}

/**
 * Clear ALL business data and every client login (Settings → Danger Zone).
 * SUPER_ADMIN only + exact confirmation phrase. Irreversible.
 */
export const resetAllDataFn = createServerFn({ method: 'POST' })
  .validator(z.object({ confirm: z.string() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requireAdmin()
    if (actor.role !== 'SUPER_ADMIN') {
      throw new Error('Only a Super Admin can clear all data')
    }
    if (data.confirm !== RESET_CONFIRM_PHRASE) {
      throw new Error(`Type "${RESET_CONFIRM_PHRASE}" exactly to confirm`)
    }

    const admin = getSupabaseAdminClient()

    // Authoritative wipe: truncate tables, delete client logins, reset counters.
    const { error } = await admin.rpc('reset_all_data')
    if (error) throw new Error(error.message)

    // Best-effort: remove the now-orphaned proof files from storage.
    try {
      await emptyBucket(admin, 'proofs')
    } catch (err) {
      console.error('[reset] failed to empty proofs bucket', err)
    }

    return { ok: true }
  })
