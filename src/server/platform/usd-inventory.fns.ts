import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { UserError } from '@/lib/errors/user-error'
import { dec } from '@/lib/money/money'
import {
  inventoryRpcError,
  previewPurchase,
} from '@/server/platform/usd-inventory.service'
import {
  feeRuleCreateSchema,
  feeRuleEndSchema,
  openingStockSchema,
  reversalSchema,
  usdOutflowPostSchema,
  usdPurchaseDraftSchema,
  usdPurchasePostSchema,
} from '@/schemas/usd-inventory'
import type { PurchasePreview } from '@/server/platform/usd-inventory.service'
import type { OutflowKind } from '@/schemas/usd-inventory'

/**
 * Platform Finance & Accounts → Batches / Fee rules (Finance v2, migration
 * 000059; docs/ACCOUNTING_POLICY.md). FIFO USD inventory: purchases are
 * batches with their fees capitalized, outflows (a Meta bill paid, the
 * opening cut-over) draw oldest-first.
 *
 * Every write is an RPC that takes the inventory lock and writes its own row
 * into platform_finance_audit — never audit_logs (org zero is also xRush
 * Agency; see finance.fns.ts). Every fn is requirePlatformAdmin()-gated.
 */

const str = (v: unknown): string => (v == null ? '0' : dec(v as string | number).toString())

// ---------------------------------------------------------------- fee rules ---

export interface FeeRuleRow {
  id: string
  code: string
  channel: string
  from_institution: string
  to_institution: string
  fee_type: string
  amount: string | null
  percent: string | null
  currency: 'BDT' | 'USD'
  your_share_pct: string
  effective_from: string
  effective_to: string | null
  notes: string | null
}

export const listFeeRulesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<FeeRuleRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('fee_rules')
      .select('*')
      .order('channel')
      .order('effective_from', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => ({
      ...(r as FeeRuleRow),
      amount: r.amount == null ? null : str(r.amount),
      percent: r.percent == null ? null : str(r.percent),
      your_share_pct: str(r.your_share_pct),
    }))
  },
)

/**
 * A new rule. Changing a fee is "end the old rule, add a new one" — past
 * purchases keep the fee snapshotted on them either way. Refused when another
 * rule for the same route would be in force on the same day (the engine would
 * refuse to choose between them at posting).
 */
export const createFeeRuleFn = createServerFn({ method: 'POST' })
  .validator(feeRuleCreateSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const from = data.from_institution.toUpperCase()
    const to = data.to_institution.toUpperCase()

    const { data: clash, error: clashErr } = await admin
      .from('fee_rules')
      .select('code, effective_to')
      .eq('channel', data.channel)
      .eq('from_institution', from)
      .eq('to_institution', to)
      .or(`effective_to.is.null,effective_to.gte.${data.effective_from}`)
    if (clashErr) throw new Error(clashErr.message)
    if (clash && clash.length > 0) {
      throw new UserError(
        `Rule "${clash[0].code}" already covers this route on ${data.effective_from}. End it first (its last day must be before the new rule starts).`,
      )
    }

    const { data: row, error } = await admin
      .from('fee_rules')
      .insert({
        code: data.code,
        channel: data.channel,
        from_institution: from,
        to_institution: to,
        fee_type: data.fee_type,
        amount: data.fee_type === 'FIXED' ? data.amount : null,
        percent: data.fee_type === 'PERCENT' ? data.percent : null,
        currency: data.currency,
        your_share_pct: data.your_share_pct,
        effective_from: data.effective_from,
        notes: data.notes ?? null,
        created_by: actor.id,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    await admin.from('platform_finance_audit').insert({
      actor_id: actor.id,
      action: 'FEE_RULE_CREATED',
      entity_type: 'FEE_RULE',
      entity_id: row.id,
      new_values: { ...data, from_institution: from, to_institution: to },
    })
    return { id: row.id as string }
  })

export const endFeeRuleFn = createServerFn({ method: 'POST' })
  .validator(feeRuleEndSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data: rule } = await admin
      .from('fee_rules')
      .select('effective_from, effective_to')
      .eq('id', data.id)
      .maybeSingle()
    if (!rule) throw new UserError('Fee rule not found')
    if (rule.effective_to) throw new UserError('That rule has already ended')
    if (data.effective_to < (rule.effective_from as string)) {
      throw new UserError('A rule cannot end before it starts')
    }
    const { error } = await admin
      .from('fee_rules')
      .update({ effective_to: data.effective_to })
      .eq('id', data.id)
      .is('effective_to', null)
    if (error) throw new Error(error.message)
    await admin.from('platform_finance_audit').insert({
      actor_id: actor.id,
      action: 'FEE_RULE_ENDED',
      entity_type: 'FEE_RULE',
      entity_id: data.id,
      new_values: { effective_to: data.effective_to },
    })
    return { ok: true }
  })

// ---------------------------------------------------------------- purchases ---

/** Fees, net USD and cost for a purchase being typed — nothing is written. */
export const previewUsdPurchaseFn = createServerFn({ method: 'POST' })
  .validator(usdPurchaseDraftSchema)
  .handler(async ({ data }): Promise<PurchasePreview> => {
    await requirePlatformAdmin()
    return previewPurchase(getSupabaseAdminClient(), data)
  })

export const postUsdPurchaseFn = createServerFn({ method: 'POST' })
  .validator(usdPurchasePostSchema)
  .handler(async ({ data }): Promise<{ id: string; duplicate: boolean }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const preview = await previewPurchase(admin, data)
    if (preview.missing.length > 0) throw new UserError(preview.missing[0].message)

    const { data: row, error } = await admin.rpc('post_usd_purchase', {
      p_actor: actor.id,
      p_source_id: data.source_id,
      p_gross_usd: data.gross_usd,
      p_bdt_principal: dec(data.bdt_principal).toDecimalPlaces(2).toNumber(),
      p_fees: preview.fees,
      p_purchased_at: data.purchased_at,
      p_method: data.method ?? null,
      p_external_reference: data.external_reference ?? null,
      p_notes: data.notes ?? null,
    })
    if (error) throw inventoryRpcError(error.message)
    const r = row as { id: string; duplicate: boolean; bdt_amount: unknown }
    // The preview and the database run the same math; disagreeing means one
    // of them is wrong, and the posted figure must not go unnoticed.
    if (!r.duplicate && preview.cost && !dec(str(r.bdt_amount)).eq(preview.cost.total_bdt_cost)) {
      throw new Error(
        `Posted cost ${str(r.bdt_amount)} differs from the preview ${preview.cost.total_bdt_cost} — check usd-batch.ts against post_usd_purchase()`,
      )
    }
    return { id: r.id, duplicate: r.duplicate }
  })

export const reverseUsdPurchaseFn = createServerFn({ method: 'POST' })
  .validator(reversalSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('reverse_usd_purchase', {
      p_actor: actor.id,
      p_purchase_id: data.id,
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

// ------------------------------------------------------------------ batches ---

export interface UsdBatchRow {
  id: string
  posting_seq: number
  purchased_at: string
  source: { id: string; name: string; payment_method: string | null } | null
  gross_usd: string
  net_usd: string
  bdt_principal: string
  capitalized_fees_bdt: string
  total_bdt_cost: string
  supplier_rate: string
  effective_rate: string
  rate_warning: boolean
  fees: Array<{ leg?: string; label?: string; currency: string; total: string; your_share: string; source: string; reason: string | null }>
  external_reference: string | null
  is_opening: boolean
  status: 'POSTED' | 'REVERSED'
  reversal_reason: string | null
  used_usd: string
  left_usd: string
  left_bdt: string
}

export interface UsdFifoSummary {
  left_usd: string
  left_bdt: string
  open_batches: number
  out_usd: string
  out_bdt: string
  /** left_bdt ÷ left_usd; null with nothing in stock. */
  avg_cost_left: string | null
  has_opening_adjustment: boolean
}

export const getUsdFifoSummaryFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<UsdFifoSummary> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const [sum, opening] = await Promise.all([
      admin.from('usd_fifo_summary').select('*').single(),
      admin
        .from('usd_outflows')
        .select('id', { count: 'exact', head: true })
        .eq('kind', 'OPENING_ADJUSTMENT')
        .eq('status', 'POSTED'),
    ])
    if (sum.error) throw new Error(sum.error.message)
    if (opening.error) throw new Error(opening.error.message)
    const r = sum.data as Record<string, unknown>
    const leftUsd = dec(str(r.left_usd))
    return {
      left_usd: leftUsd.toFixed(2),
      left_bdt: dec(str(r.left_bdt)).toFixed(2),
      open_batches: Number(r.open_batches ?? 0),
      out_usd: dec(str(r.out_usd)).toFixed(2),
      out_bdt: dec(str(r.out_bdt)).toFixed(2),
      avg_cost_left: leftUsd.isZero() ? null : dec(str(r.left_bdt)).div(leftUsd).toFixed(6),
      has_opening_adjustment: (opening.count ?? 0) > 0,
    }
  },
)

export const listUsdBatchesFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<UsdBatchRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const [batches, balances] = await Promise.all([
      admin
        .from('usd_purchases')
        .select(
          'id, posting_seq, purchased_at, gross_usd, net_usd, bdt_principal, capitalized_fees_bdt, bdt_amount, supplier_rate, effective_rate, rate_warning, fees, external_reference, is_opening, status, reversal_reason, source:usd_sources(id, name, payment_method)',
        )
        .order('posting_seq', { ascending: false })
        .limit(500),
      admin.from('usd_batch_balances').select('batch_id, used_usd, left_usd, left_bdt'),
    ])
    if (batches.error) throw new Error(batches.error.message)
    if (balances.error) throw new Error(balances.error.message)
    const bal = new Map(
      (balances.data ?? []).map((b) => [b.batch_id as string, b as Record<string, unknown>]),
    )
    return (batches.data ?? []).map((raw) => {
      const p = raw as unknown as Record<string, unknown> & { id: string }
      const b = bal.get(p.id)
      return {
        id: p.id,
        posting_seq: Number(p.posting_seq),
        purchased_at: p.purchased_at as string,
        source: p.source as UsdBatchRow['source'],
        gross_usd: str(p.gross_usd),
        net_usd: str(p.net_usd),
        bdt_principal: str(p.bdt_principal),
        capitalized_fees_bdt: str(p.capitalized_fees_bdt),
        total_bdt_cost: str(p.bdt_amount),
        supplier_rate: str(p.supplier_rate),
        effective_rate: str(p.effective_rate),
        rate_warning: p.rate_warning as boolean,
        fees: (p.fees ?? []) as UsdBatchRow['fees'],
        external_reference: p.external_reference as string | null,
        is_opening: p.is_opening as boolean,
        status: p.status as UsdBatchRow['status'],
        reversal_reason: p.reversal_reason as string | null,
        used_usd: str(b?.used_usd),
        left_usd: str(b?.left_usd ?? p.net_usd),
        left_bdt: str(b?.left_bdt ?? p.bdt_amount),
      }
    })
  },
)

// ----------------------------------------------------------------- outflows ---

export interface UsdOutflowRow {
  id: string
  reference_id: string
  kind: OutflowKind
  ad_account: { id: string; account_code: string; name: string } | null
  usd_amount: string
  bdt_cost: string
  event_at: string
  status: 'POSTED' | 'REVERSED'
  reversal_reason: string | null
  notes: string | null
  allocations: Array<{ batch_seq: number; usd: string; bdt: string; is_reversal: boolean }>
}

export const listUsdOutflowsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<UsdOutflowRow>> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('usd_outflows')
      .select(
        'id, reference_id, kind, usd_amount, bdt_cost, event_at, status, reversal_reason, notes, ad_account:ad_accounts(id, account_code, name), allocations:inventory_allocations(usd, bdt, is_reversal, batch:usd_purchases(posting_seq))',
      )
      .order('event_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw new Error(error.message)
    return (data ?? []).map((raw) => {
      const o = raw as unknown as Record<string, unknown> & {
        allocations: Array<{ usd: unknown; bdt: unknown; is_reversal: boolean; batch: { posting_seq: number } | null }>
      }
      return {
        id: o.id as string,
        reference_id: o.reference_id as string,
        kind: o.kind as OutflowKind,
        ad_account: o.ad_account as UsdOutflowRow['ad_account'],
        usd_amount: str(o.usd_amount),
        bdt_cost: str(o.bdt_cost),
        event_at: o.event_at as string,
        status: o.status as UsdOutflowRow['status'],
        reversal_reason: o.reversal_reason as string | null,
        notes: o.notes as string | null,
        allocations: (o.allocations ?? [])
          .map((a) => ({
            batch_seq: Number(a.batch?.posting_seq ?? 0),
            usd: str(a.usd),
            bdt: str(a.bdt),
            is_reversal: a.is_reversal,
          }))
          .sort((a, b) => a.batch_seq - b.batch_seq),
      }
    })
  },
)

/** Platform-owned ad accounts — the Meta bill an outflow paid. */
export const listPlatformAdAccountsForBillsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<{ id: string; account_code: string; name: string }>> => {
    await requirePlatformAdmin()
    const { data, error } = await getSupabaseAdminClient()
      .from('ad_accounts')
      .select('id, account_code, name')
      .eq('is_platform', true)
      .order('account_code')
    if (error) throw new Error(error.message)
    return (data ?? []) as Array<{ id: string; account_code: string; name: string }>
  },
)

export const postUsdOutflowFn = createServerFn({ method: 'POST' })
  .validator(usdOutflowPostSchema)
  .handler(async ({ data }): Promise<{ id: string; bdt_cost: string; duplicate: boolean }> => {
    const actor = await requirePlatformAdmin()
    const { data: row, error } = await getSupabaseAdminClient().rpc('post_usd_outflow', {
      p_actor: actor.id,
      p_kind: data.kind,
      p_usd: data.usd_amount,
      p_event_at: data.event_at,
      p_ad_account_id: data.kind === 'OTHER' ? null : data.ad_account_id,
      p_idempotency_key: data.idempotency_key,
      p_notes: data.notes ?? null,
    })
    if (error) throw inventoryRpcError(error.message)
    const r = row as { id: string; bdt_cost: unknown; duplicate: boolean }
    return { id: r.id, bdt_cost: str(r.bdt_cost), duplicate: r.duplicate }
  })

export const reverseUsdOutflowFn = createServerFn({ method: 'POST' })
  .validator(reversalSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const actor = await requirePlatformAdmin()
    const { error } = await getSupabaseAdminClient().rpc('reverse_usd_outflow', {
      p_actor: actor.id,
      p_outflow_id: data.id,
      p_reason: data.reason,
    })
    if (error) throw inventoryRpcError(error.message)
    return { ok: true }
  })

/**
 * Cut-over to FIFO. Every purchase recorded before v2 counts as still in
 * stock; the owner enters the USD actually on hand (all wallets) and the
 * difference is posted as one OPENING_ADJUSTMENT outflow, drawn oldest-first —
 * the dollars that were already spent before v2 existed. Once only (a
 * reversed one can be redone).
 */
export const setOpeningStockFn = createServerFn({ method: 'POST' })
  .validator(openingStockSchema)
  .handler(async ({ data }): Promise<{ adjusted_usd: string }> => {
    const actor = await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const { count, error: cErr } = await admin
      .from('usd_outflows')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'OPENING_ADJUSTMENT')
      .eq('status', 'POSTED')
    if (cErr) throw new Error(cErr.message)
    if ((count ?? 0) > 0) {
      throw new UserError('The opening stock is already set. Reverse that adjustment first to set it again.')
    }
    const { data: sum, error } = await admin.from('usd_fifo_summary').select('left_usd').single()
    if (error) throw new Error(error.message)
    const recorded = dec(str((sum as { left_usd: unknown }).left_usd))
    const diff = recorded.minus(data.on_hand_usd).toDecimalPlaces(2)
    if (diff.isNegative()) {
      throw new UserError(
        `You have ${dec(data.on_hand_usd).toFixed(2)} USD on hand but only ${recorded.toFixed(2)} USD recorded. Record the missing purchases first.`,
      )
    }
    if (diff.isZero()) return { adjusted_usd: '0.00' }
    const { error: rpcErr } = await admin.rpc('post_usd_outflow', {
      p_actor: actor.id,
      p_kind: 'OPENING_ADJUSTMENT',
      p_usd: diff.toNumber(),
      p_event_at: data.as_of,
      p_ad_account_id: null,
      p_idempotency_key: `opening-${crypto.randomUUID()}`,
      p_notes: `Opening stock ${dec(data.on_hand_usd).toFixed(2)} USD on hand. ${data.notes}`,
    })
    if (rpcErr) throw inventoryRpcError(rpcErr.message)
    return { adjusted_usd: diff.toFixed(2) }
  })
