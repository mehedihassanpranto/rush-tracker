import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requirePlatformAdmin } from '@/server/auth/guards.server'
import { dec } from '@/lib/money/money'

/**
 * Platform Finance & Accounts → Journal (Finance v2 Milestone 2, migration
 * 000061). Read-only: entries are posted by database triggers on purchases,
 * USD payouts and agency sales, never from here. Platform admins only.
 */

const str = (v: unknown): string => (v == null ? '0' : dec(v as string | number).toFixed(2))

export interface TrialBalanceRow {
  code: string
  name: string
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
  normal_side: 'DEBIT' | 'CREDIT'
  debit_bdt: string
  credit_bdt: string
  balance_bdt: string
  /** Net USD memo, for accounts that move dollars; null otherwise. */
  usd: string | null
}

export interface TrialBalance {
  as_of: string
  rows: Array<TrialBalanceRow>
  total_debit: string
  total_credit: string
  /**
   * The USD inventory account against the FIFO stock. Compared over
   * EVERYTHING posted (not as of the chosen date): FIFO stock has no date, so
   * a dated comparison would report a false mismatch whenever something is
   * dated after it.
   */
  tie_out: {
    books_bdt: string
    books_usd: string
    fifo_bdt: string
    fifo_usd: string
    ties: boolean
  }
}

async function trialBalance(asOf: string): Promise<Array<TrialBalanceRow>> {
  const admin = getSupabaseAdminClient()
  const { data, error } = await admin.rpc('gl_trial_balance', { p_as_of: asOf })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    code: r.code as string,
    name: r.name as string,
    type: r.type as TrialBalanceRow['type'],
    normal_side: r.normal_side as TrialBalanceRow['normal_side'],
    debit_bdt: str(r.debit_bdt),
    credit_bdt: str(r.credit_bdt),
    balance_bdt: str(r.balance_bdt),
    usd: r.usd == null ? null : str(r.usd),
  }))
}

export const getTrialBalanceFn = createServerFn({ method: 'GET' })
  .validator(z.object({ as_of: z.iso.datetime({ offset: true }).optional() }))
  .handler(async ({ data }): Promise<TrialBalance> => {
    await requirePlatformAdmin()
    const admin = getSupabaseAdminClient()
    const asOf = data.as_of ?? new Date().toISOString()
    const [rows, allTime, fifo] = await Promise.all([
      trialBalance(asOf),
      trialBalance('infinity'),
      admin.from('usd_fifo_summary').select('left_usd, left_bdt').single(),
    ])
    if (fifo.error) throw new Error(fifo.error.message)

    const inv = allTime.find((r) => r.code === '1200')
    const books_bdt = inv?.balance_bdt ?? '0.00'
    const books_usd = inv?.usd ?? '0.00'
    const f = fifo.data as { left_usd: unknown; left_bdt: unknown }
    const fifo_bdt = str(f.left_bdt)
    const fifo_usd = str(f.left_usd)

    return {
      as_of: asOf,
      rows,
      total_debit: rows.reduce((s, r) => s.plus(r.debit_bdt), dec(0)).toFixed(2),
      total_credit: rows.reduce((s, r) => s.plus(r.credit_bdt), dec(0)).toFixed(2),
      tie_out: {
        books_bdt,
        books_usd,
        fifo_bdt,
        fifo_usd,
        ties: dec(books_bdt).eq(fifo_bdt) && dec(books_usd).eq(fifo_usd),
      },
    }
  })

export interface JournalEntryRow {
  id: string
  entry_number: string
  event_at: string
  source_type: string
  is_reversal: boolean
  description: string
  lines: Array<{
    line_no: number
    account_code: string
    account_name: string
    debit_bdt: string
    credit_bdt: string
    usd_amount: string | null
    memo: string | null
  }>
}

export const listJournalEntriesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ limit: z.number().int().min(1).max(500).optional() }))
  .handler(async ({ data }): Promise<Array<JournalEntryRow>> => {
    await requirePlatformAdmin()
    const { data: rows, error } = await getSupabaseAdminClient()
      .from('journal_entries')
      .select(
        'id, entry_number, event_at, source_type, is_reversal, description, lines:journal_lines(line_no, account_code, debit_bdt, credit_bdt, usd_amount, memo, account:gl_accounts(name))',
      )
      // Most recently POSTED first. Event dates can sit in the future (a
      // payment dated tomorrow) and would otherwise bury today's postings.
      .order('created_at', { ascending: false })
      .order('entry_number', { ascending: false })
      .limit(data.limit ?? 100)
    if (error) throw new Error(error.message)
    return (rows ?? []).map((raw) => {
      const e = raw as unknown as Omit<JournalEntryRow, 'lines'> & {
        lines: Array<Record<string, unknown> & { account: { name: string } | null }>
      }
      return {
        id: e.id,
        entry_number: e.entry_number,
        event_at: e.event_at,
        source_type: e.source_type,
        is_reversal: e.is_reversal,
        description: e.description,
        lines: e.lines
          .map((l) => ({
            line_no: Number(l.line_no),
            account_code: l.account_code as string,
            account_name: l.account?.name ?? '',
            debit_bdt: str(l.debit_bdt),
            credit_bdt: str(l.credit_bdt),
            usd_amount: l.usd_amount == null ? null : dec(l.usd_amount as number).toFixed(2),
            memo: (l.memo as string | null) ?? null,
          }))
          .sort((a, b) => a.line_no - b.line_no),
      }
    })
  })
