import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { dec } from '@/lib/money/money'
import { inventoryRpcError } from '@/server/platform/usd-inventory.service'
import { readPoolSpend } from '@/server/platform/meta-spend.service'
import {
  manualMetaSpendSchema,
  metaBillingModeSchema,
  resolveExceptionSchema,
  reversalSchema,
} from '@/schemas/usd-inventory'
import type { PoolSpendResult } from '@/server/platform/meta-spend.service'
import type { MetaBillingMode } from '@/schemas/usd-inventory'

/**
 * Platform Finance & Accounts → Meta Accounts (Finance v2 Milestone 3,
 * migration 000063): each pool account's Meta billing mode, the spend read
 * from Meta each day, prepaid credit and what is owed to Meta. Every write is
 * an RPC that takes the inventory lock and audits into platform_finance_audit.
 * Platform admins only — an agency never sees cost or spend tracking.
 */

const usd = (v: unknown): string => (v == null ? '0.00' : dec(v as string | number).toFixed(2))
const bdt = usd

export interface MetaAccountPosition {
  ad_account_id: string
  account_code: string
  name: string
  status: string
  meta_billing_mode: MetaBillingMode
  /** Meta's own balance / currency, for comparison only. */
  meta_balance: string | null
  meta_currency: string | null
  meta_refreshed_at: string | null
  tracking_since: string | null
  last_read_at: string | null
  spent_usd: string
  funded_usd: string
  prepaid_left_usd: string
  prepaid_left_bdt: string
  paid_usd: string
  owed_usd: string
  open_exceptions: number
}

export const listMetaAccountPositionsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<MetaAccountPosition>> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient()
      .from('meta_account_positions')
      .select('*')
      .order('account_code')
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => ({
      ad_account_id: r.ad_account_id as string,
      account_code: r.account_code as string,
      name: r.name as string,
      status: r.status as string,
      meta_billing_mode: r.meta_billing_mode as MetaBillingMode,
      meta_balance: r.meta_balance == null ? null : String(r.meta_balance),
      meta_currency: (r.meta_currency as string | null) ?? null,
      meta_refreshed_at: (r.meta_refreshed_at as string | null) ?? null,
      tracking_since: (r.tracking_since as string | null) ?? null,
      last_read_at: (r.last_read_at as string | null) ?? null,
      spent_usd: usd(r.spent_usd),
      funded_usd: usd(r.funded_usd),
      prepaid_left_usd: usd(r.prepaid_left_usd),
      prepaid_left_bdt: bdt(r.prepaid_left_bdt),
      paid_usd: usd(r.paid_usd),
      owed_usd: usd(r.owed_usd),
      open_exceptions: Number(r.open_exceptions ?? 0),
    }))
  },
)

export interface MetaSpendEventRow {
  id: string
  reference_id: string
  ad_account: { id: string; account_code: string; name: string } | null
  billing_mode: MetaBillingMode
  usd_amount: string
  covered_usd: string
  unfunded_usd: string
  bdt_cost: string
  event_at: string
  source: 'SYNC' | 'MANUAL'
  status: 'POSTED' | 'REVERSED'
  reversal_reason: string | null
  notes: string | null
}

export const listMetaSpendEventsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<MetaSpendEventRow>> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient()
      .from('meta_spend_events')
      .select(
        'id, reference_id, billing_mode, usd_amount, covered_usd, unfunded_usd, bdt_cost, event_at, source, status, reversal_reason, notes, ad_account:ad_accounts(id, account_code, name)',
      )
      .order('event_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw new Error(error.message)
    return (data ?? []).map((raw) => {
      const r = raw as unknown as Record<string, unknown>
      return {
        id: r.id as string,
        reference_id: r.reference_id as string,
        ad_account: r.ad_account as MetaSpendEventRow['ad_account'],
        billing_mode: r.billing_mode as MetaBillingMode,
        usd_amount: usd(r.usd_amount),
        covered_usd: usd(r.covered_usd),
        unfunded_usd: usd(r.unfunded_usd),
        bdt_cost: bdt(r.bdt_cost),
        event_at: r.event_at as string,
        source: r.source as MetaSpendEventRow['source'],
        status: r.status as MetaSpendEventRow['status'],
        reversal_reason: (r.reversal_reason as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
      }
    })
  },
)

export interface MetaSpendExceptionRow {
  id: string
  ad_account: { id: string; account_code: string; name: string } | null
  kind: 'NEGATIVE_CHANGE' | 'UNFUNDED_SPEND' | 'NON_USD'
  usd: string | null
  details: Record<string, string | number | null>
  event_at: string
}

export const listOpenMetaExceptionsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<MetaSpendExceptionRow>> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient()
      .from('meta_spend_exceptions')
      .select('id, kind, usd, details, event_at, ad_account:ad_accounts(id, account_code, name)')
      .is('resolved_at', null)
      .order('event_at', { ascending: false })
      .limit(200)
    if (error) throw new Error(error.message)
    return (data ?? []).map((raw) => {
      const r = raw as unknown as Record<string, unknown>
      return {
        id: r.id as string,
        ad_account: r.ad_account as MetaSpendExceptionRow['ad_account'],
        kind: r.kind as MetaSpendExceptionRow['kind'],
        usd: r.usd == null ? null : usd(r.usd),
        details: (r.details ?? {}) as MetaSpendExceptionRow['details'],
        event_at: r.event_at as string,
      }
    })
  },
)

/** Read every pool account from Meta now and post the spend since the last
 * reading — the same job the daily cron runs. */
export const readPoolSpendNowFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<PoolSpendResult> => {
    const actor = await requirePlatformAdmin()
    return readPoolSpend(actor.id)
  },
)

export const recordManualMetaSpendFn = createServerFn({ method: 'POST' })
  .validator(manualMetaSpendSchema)
  .handler(async ({ data }): Promise<{ id: string; duplicate: boolean }> => {
    const actor = await requirePlatformAdmin()
    const { data: row, error } = await getSupabaseAdminClient().rpc('record_manual_meta_spend', {
      p_actor: actor.id,
      p_account: data.ad_account_id,
      p_usd: data.usd_amount,
      p_event_at: data.event_at,
      p_notes: data.notes,
      p_key: data.idempotency_key,
    })
    if (error) throw inventoryRpcError(error.message)
    const r = row as { id: string; duplicate: boolean }
    return { id: r.id, duplicate: r.duplicate }
  })

export const reverseMetaSpendFn = createServerFn({ method: 'POST' })
  .validator(reversalSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('reverse_meta_spend', {
      p_actor: actor.id,
      p_event: data.id,
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

export const setMetaBillingModeFn = createServerFn({ method: 'POST' })
  .validator(metaBillingModeSchema)
  .handler(async ({ data }): Promise<{ changed: boolean }> => {
    const actor = await requirePlatformAdmin()
    const { data: r, error } = await getSupabaseAdminClient().rpc('set_meta_billing_mode', {
      p_actor: actor.id,
      p_account: data.ad_account_id,
      p_mode: data.mode,
    })
    if (error) throw inventoryRpcError(error.message)
    return { changed: (r as { changed: boolean }).changed }
  })

export const resolveMetaExceptionFn = createServerFn({ method: 'POST' })
  .validator(resolveExceptionSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('resolve_meta_spend_exception', {
      p_actor: actor.id,
      p_id: data.id,
      p_note: data.note,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })
