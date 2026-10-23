import { dec } from '@/lib/money/money'
import type { SupabaseClient } from '@supabase/supabase-js'

const money = (v: unknown): string => (v == null ? '0.00' : dec(v as string | number).toFixed(2))

export interface AgencyStatementRow {
  date: string
  reference: string
  description: string
  usd: string | null
  rate: string | null
  billed_bdt: string | null
  paid_bdt: string | null
  balance_bdt: string
}

/**
 * Client-safe: what the agency was billed and paid, and the running balance —
 * its own rate, but no cost, margin, supplier or stock figure. Oldest first.
 */
export async function buildAgencyStatement(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ agency: string; rows: Array<AgencyStatementRow> }> {
  const [org, charges, payments] = await Promise.all([
    admin.from('organizations').select('name').eq('id', organizationId).single(),
    admin
      .from('agency_charges')
      .select('reference_id, kind, usd_amount, rate, bdt_amount, event_at, notes, ad_account:ad_accounts(account_code)')
      .eq('organization_id', organizationId)
      .eq('status', 'POSTED'),
    admin
      .from('agency_payments')
      .select('reference_id, bdt_amount, received_at, method')
      .eq('organization_id', organizationId)
      .eq('status', 'POSTED'),
  ])
  if (org.error) throw new Error(org.error.message)
  if (charges.error) throw new Error(charges.error.message)
  if (payments.error) throw new Error(payments.error.message)

  type Ev = Omit<AgencyStatementRow, 'balance_bdt'> & { delta: ReturnType<typeof dec> }
  const events: Array<Ev> = [
    ...(charges.data ?? []).map((raw) => {
      const c = raw as unknown as Record<string, unknown> & { ad_account: { account_code: string } | null }
      const bdtAmt = dec(c.bdt_amount as number)
      const opening = c.kind === 'OPENING_BALANCE'
      return {
        date: c.event_at as string,
        reference: c.reference_id as string,
        description: opening
          ? bdtAmt.isNegative() ? 'Opening credit' : 'Opening balance'
          : `Limit approved${c.ad_account ? ` on ${c.ad_account.account_code}` : ''}${c.notes ? ` (${String(c.notes)})` : ''}`,
        usd: c.usd_amount == null ? null : money(c.usd_amount),
        rate: c.rate == null ? null : dec(c.rate as number).toFixed(2),
        billed_bdt: bdtAmt.isNegative() ? null : bdtAmt.toFixed(2),
        paid_bdt: bdtAmt.isNegative() ? bdtAmt.abs().toFixed(2) : null,
        delta: bdtAmt,
      }
    }),
    ...(payments.data ?? []).map((p) => ({
      date: p.received_at as string,
      reference: p.reference_id as string,
      description: `Payment received${p.method ? ` (${String(p.method)})` : ''}`,
      usd: null,
      rate: null,
      billed_bdt: null,
      paid_bdt: money(p.bdt_amount),
      delta: dec(p.bdt_amount as number).neg(),
    })),
  ].sort((a, b) => a.date.localeCompare(b.date))

  let running = dec(0)
  const rows = events.map(({ delta, ...e }) => {
    running = running.plus(delta)
    return { ...e, balance_bdt: running.toFixed(2) }
  })
  return { agency: org.data.name as string, rows }
}
