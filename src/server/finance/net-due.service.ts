import type { SupabaseClient } from '@supabase/supabase-js'
import { dec } from '@/lib/money/money'
import { accountAdCreditUsd, netDueFigures } from '@/lib/money/net-due'
import type { NetDueFigures } from '@/lib/money/net-due'
import { bdtToUsd, resolveAccountUsdRate } from '@/server/exchange-rates/rate.service'
import { refreshMetaSnapshots } from '@/server/meta/meta-snapshot.server'
import type { SnapshotRow } from '@/server/meta/meta-snapshot.server'

interface AssignedAccount extends SnapshotRow {
  external_account_id: string
  usd_rate: string | number
  meta_amount_spent: string | number | null
  meta_spend_cap: string | number | null
  meta_currency: string | null
  meta_refreshed_at: string | null
}

/**
 * Net Receivable / Amount Payable figures per client (src/lib/money/net-due.ts).
 *
 * The CALLER authorizes: every id in `clients` must already be checked to
 * belong to the caller's organization (or to the signed-in client).
 *
 * Ad credit comes from the client's ACTIVE assignments only. With `live`, each
 * linked account is read straight from Meta (saving the snapshot as a side
 * effect); an account Meta doesn't return falls back to its saved snapshot,
 * and one with neither counts in `unreadAccounts`. Without `live` (the
 * platform's read-only support view) only saved snapshots are used.
 * BDT conversion follows adAccountUsdRate()'s rule: the account's rate, else
 * the client's.
 */
export async function netDueForClients(
  admin: SupabaseClient,
  clients: Array<{ id: string; usd_rate: string | number; current_due: string | number }>,
  opts: { live: boolean },
): Promise<Map<string, NetDueFigures>> {
  const result = new Map<string, NetDueFigures>()
  if (clients.length === 0) return result

  const { data, error } = await admin
    .from('ad_account_assignments')
    .select(
      'client_id, account:ad_accounts(id, name, external_account_id, is_platform, organization_id, usd_rate, meta_amount_spent, meta_spend_cap, meta_currency, meta_refreshed_at)',
    )
    .in('client_id', clients.map((c) => c.id))
    .eq('status', 'ACTIVE')
  if (error) throw new Error(error.message)

  const linked = ((data ?? []) as unknown as Array<{
    client_id: string
    account: (Omit<AssignedAccount, 'external_account_id'> & { external_account_id: string | null }) | null
  }>).flatMap((r) =>
    r.account?.external_account_id
      ? [{ clientId: r.client_id, account: r.account as AssignedAccount }]
      : [],
  )

  const live = opts.live
    ? (await refreshMetaSnapshots(linked.map((l) => l.account))).byId
    : new Map()

  const byClient = new Map<string, typeof linked>()
  for (const l of linked) byClient.set(l.clientId, [...(byClient.get(l.clientId) ?? []), l])

  for (const client of clients) {
    let creditUsd = dec(0)
    let creditBdt = dec(0)
    let unread = 0
    for (const { account } of byClient.get(client.id) ?? []) {
      const m = live.get(account.id)
      const figures = m
        ? { currency: m.currency, spend_cap: m.spend_cap, amount_spent: m.amount_spent }
        : account.meta_refreshed_at
          ? {
              currency: account.meta_currency,
              spend_cap: account.meta_spend_cap,
              amount_spent: account.meta_amount_spent,
            }
          : null
      if (!figures) {
        unread++
        continue
      }
      const usd = accountAdCreditUsd(figures)
      if (usd == null) continue
      const rate = resolveAccountUsdRate(account.usd_rate, client.usd_rate)
      creditUsd = creditUsd.plus(dec(usd))
      creditBdt = creditBdt.plus(dec(usd).times(dec(rate)).toDecimalPlaces(2))
    }
    const dueBdt = String(client.current_due ?? 0)
    result.set(
      client.id,
      netDueFigures({
        grossDueBdt: dueBdt,
        grossDueUsd: bdtToUsd(dueBdt, String(client.usd_rate ?? 0)),
        adCreditUsd: creditUsd.toFixed(2),
        adCreditBdt: creditBdt.toFixed(2),
        unreadAccounts: unread,
      }),
    )
  }
  return result
}

/** Every client of one organization, with its ledger due — the input
 * netDueForClients needs for an agency-wide rollup. */
export async function organizationClientDues(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Array<{ id: string; usd_rate: string; current_due: string }>> {
  const [{ data: rates, error: rateError }, { data: dues, error: dueError }] = await Promise.all([
    admin.from('clients').select('id, usd_rate').eq('organization_id', organizationId),
    admin.rpc('all_client_dues', { p_organization_id: organizationId }),
  ])
  if (rateError) throw new Error(rateError.message)
  if (dueError) throw new Error(dueError.message)
  const dueById = new Map(
    ((dues ?? []) as Array<{ client_id: string; current_due: string | number }>).map((d) => [
      d.client_id,
      String(d.current_due),
    ]),
  )
  return ((rates ?? []) as Array<{ id: string; usd_rate: string | number }>).map((c) => ({
    id: c.id,
    usd_rate: String(c.usd_rate),
    current_due: dueById.get(c.id) ?? '0',
  }))
}
