import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import {
  usdPurchaseListSchema,
  usdSourceCreateSchema,
  usdSourceStatusSchema,
  usdSourceUpdateSchema,
} from '@/schemas/platform-finance'
import type { UsdPurchaseWithSource, UsdSource } from '@/types/domain'

/**
 * Platform Management -> Finance & Accounts: suppliers (usd_sources) and the
 * purchase list. Everything else of the platform's books lives in the Finance
 * v2 modules (usd-inventory, meta-accounts, agency-billing, journal,
 * finance-close .fns.ts). Every fn is requirePlatformAdmin()-gated; none takes
 * an organization from the session: this is the platform's own book.
 *
 * WHAT MUST NEVER HAPPEN: purchases, suppliers or buying rates reaching an
 * agency. Nothing here is reachable without requirePlatformAdmin, and the
 * tables refuse anon/authenticated outright (migrations 000041, 000059).
 *
 * AUDIT PLACEMENT — read before "fixing" it. Purchases and suppliers are
 * deliberately NOT written to audit_logs. That table needs an organization_id,
 * and the platform's own home organization is org zero, which is ALSO xRush
 * Agency — whose admins read that log at /agency/audit. Auditing a purchase
 * there would hand a customer the platform's cost basis. Finance v2 writes its
 * own trail to platform_finance_audit instead.
 *
 * The weighted-average stock ledger and "Record agency sale" that used to live
 * here were retired in Finance v2 Milestone 5 (FIFO inventory and agency
 * billing replace them); usd_sales and its views stay in the database as
 * history.
 */

function friendlyDuplicate(message: string, code?: string): string | null {
  return code === '23505' || /duplicate key/i.test(message)
    ? 'A source with that name already exists.'
    : null
}

// ----------------------------------------------------------------- sources ---

function sortSources<T extends { name: string }>(rows: Array<T>): Array<T> {
  return [...rows].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
}

export const listUsdSourcesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<UsdSource>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin.from('usd_sources').select('*')
    if (error) throw new Error(error.message)
    return sortSources((data ?? []) as Array<UsdSource>)
  },
)

export const createUsdSourceFn = createServerFn({ method: 'POST' })
  .validator(usdSourceCreateSchema)
  .handler(async ({ data }): Promise<UsdSource> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: row, error } = await admin
      .from('usd_sources')
      .insert({
        name: data.name,
        payment_method: data.payment_method,
        receiving_institution: data.receiving_institution ?? null,
      })
      .select('*')
      .single()
    if (error) {
      throw new Error(friendlyDuplicate(error.message, error.code) ?? error.message)
    }
    return row as UsdSource
  })

/** Rename a source or set how it pays in USD. This is also how a source that
 * predates the payment_method column gets one. Past purchases keep pointing at
 * the same source id, so nothing recorded is disturbed. */
export const updateUsdSourceFn = createServerFn({ method: 'POST' })
  .validator(usdSourceUpdateSchema)
  .handler(async ({ data }): Promise<UsdSource> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: updated, error } = await admin
      .from('usd_sources')
      .update({
        name: data.name,
        payment_method: data.payment_method,
        receiving_institution: data.receiving_institution ?? null,
      })
      .eq('id', data.id)
      .select('*')
    if (error) {
      throw new Error(friendlyDuplicate(error.message, error.code) ?? error.message)
    }
    if (!updated || updated.length === 0) throw new Error('Source not found')
    return updated[0] as UsdSource
  })

export const setUsdSourceActiveFn = createServerFn({ method: 'POST' })
  .validator(usdSourceStatusSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: updated, error } = await admin
      .from('usd_sources')
      .update({ is_active: data.is_active })
      .eq('id', data.id)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) throw new Error('Source not found')
    return { ok: true }
  })

// --------------------------------------------------------------- purchases ---

export const listUsdPurchasesFn = createServerFn({ method: 'GET' })
  .validator(usdPurchaseListSchema)
  .handler(async ({ data }): Promise<Array<UsdPurchaseWithSource>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    let query = admin
      .from('usd_purchases')
      .select('*, source:usd_sources(id, name, payment_method)')
      .eq('status', 'POSTED')
      .order('purchased_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500)
    if (data.source_id) query = query.eq('source_id', data.source_id)
    const { data: rows, error } = await query
    if (error) throw new Error(error.message)
    return (rows ?? []) as unknown as Array<UsdPurchaseWithSource>
  })

// Recording a purchase moved to postUsdPurchaseFn (usd-inventory.fns.ts):
// it resolves the transfer fees and posts a FIFO batch through the
// post_usd_purchase() RPC (migration 000059).
