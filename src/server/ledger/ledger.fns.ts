import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import {
  requireAdmin,
  requireClientMembership,
} from '@/server/auth/guards.server'
import { bdtToUsd, clientUsdRate } from '@/server/exchange-rates/rate.service'
import { withRunningBalance } from '@/lib/ledger/running-balance'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import type {
  ClientFinancials,
  LedgerEntry,
  LedgerEntryWithBalance,
  LedgerEntryWithClient,
} from '@/types/domain'

const EMPTY_FINANCIALS: ClientFinancials = {
  total_debit: '0',
  total_credit: '0',
  current_due: '0',
  total_approved_usd: '0',
  current_due_usd: '0',
}

async function fetchClientFinancials(
  clientId: string,
): Promise<ClientFinancials> {
  const admin = getSupabaseAdminClient()
  const { data, error } = await admin.rpc('client_financials', {
    p_client_id: clientId,
  })
  if (error) throw new Error(error.message)
  const row = (data as Array<Omit<ClientFinancials, 'current_due_usd'>> | null)?.[0]
  if (!row) return EMPTY_FINANCIALS
  const rate = await clientUsdRate(clientId)
  return { ...row, current_due_usd: bdtToUsd(row.current_due, rate) }
}

const LEDGER_COLUMNS =
  'id, transaction_number, client_id, type, reference_type, reference_id, usd_amount, usd_rate, bdt_amount, debit_bdt, credit_bdt, description, created_at'

// ===========================================================================
// Admin
// ===========================================================================

export const clientFinancialsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<ClientFinancials> => {
    await requireAdmin(PERMISSIONS.CLIENTS_VIEW)
    return fetchClientFinancials(data.client_id)
  })

export const listClientLedgerFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<LedgerEntryWithBalance>> => {
    await requireAdmin(PERMISSIONS.LEDGER_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: rows, error } = await admin
      .from('ledger_entries')
      .select(LEDGER_COLUMNS)
      .eq('client_id', data.client_id)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return withRunningBalance((rows ?? []) as unknown as Array<LedgerEntry>)
  })

export const listLedgerFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<LedgerEntryWithClient>> => {
    await requireAdmin(PERMISSIONS.LEDGER_VIEW)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('ledger_entries')
      .select(`${LEDGER_COLUMNS}, client:clients(id, client_code, name)`)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw new Error(error.message)
    return data as unknown as Array<LedgerEntryWithClient>
  },
)

// ===========================================================================
// Client (statement — spec §66 statement, §35 due)
// ===========================================================================

export interface MyStatement {
  financials: ClientFinancials
  entries: Array<LedgerEntryWithBalance>
}

export const getMyStatementFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MyStatement> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    const { data: rows, error } = await admin
      .from('ledger_entries')
      .select(LEDGER_COLUMNS)
      .eq('client_id', membership.clientId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)

    const financials = await fetchClientFinancials(membership.clientId)
    return {
      financials,
      entries: withRunningBalance((rows ?? []) as unknown as Array<LedgerEntry>),
    }
  },
)
