import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin, requireClientMembership } from '@/server/auth/guards.server'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { sumNetDueFigures } from '@/lib/money/net-due'
import type { NetDueFigures } from '@/lib/money/net-due'
import { netDueForClients, organizationClientDues } from '@/server/finance/net-due.service'

/**
 * Net Receivable (agency) / Amount Payable (client) — gross ledger due minus
 * the unused balance on the client's active Meta ad accounts. See
 * src/lib/money/net-due.ts. Read Meta live (snapshot fallback), so these are
 * kept separate from the instant ledger stats.
 */

async function oneClient(clientId: string): Promise<NetDueFigures> {
  const admin = getSupabaseAdminClient()
  const [{ data: client, error }, { data: fin, error: finError }] = await Promise.all([
    admin.from('clients').select('id, usd_rate').eq('id', clientId).single(),
    admin.rpc('client_financials', { p_client_id: clientId }),
  ])
  if (error) throw new Error(error.message)
  if (finError) throw new Error(finError.message)
  const due = (fin as Array<{ current_due: string | number }> | null)?.[0]?.current_due ?? 0
  const byClient = await netDueForClients(
    admin,
    [{ id: clientId, usd_rate: (client as { usd_rate: string }).usd_rate, current_due: String(due) }],
    { live: true },
  )
  return byClient.get(clientId)!
}

/** The signed-in client's own Amount Payable. */
export const myNetPayableFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<NetDueFigures> => {
    const { membership } = await requireClientMembership()
    return oneClient(membership.clientId)
  },
)

/** One client's Net Receivable, for the agency's client detail page. */
export const clientNetReceivableFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<NetDueFigures> => {
    const actor = await requireAdmin(PERMISSIONS.CLIENTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: owned, error } = await admin
      .from('clients')
      .select('id')
      .eq('id', data.client_id)
      .eq('organization_id', actor.organizationId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!owned) throw new Error('Client not found')
    return oneClient(data.client_id)
  })

const AGENCY_VIEW_PERMISSION = {
  dashboard: PERMISSIONS.DASHBOARD_VIEW,
  clients: PERMISSIONS.CLIENTS_VIEW,
  reports: PERMISSIONS.REPORTS_VIEW,
} as const

export interface AgencyNetReceivable {
  totals: NetDueFigures
  byClient: Record<string, NetDueFigures>
}

/**
 * Agency-wide rollup plus the per-client figures it sums. `view` picks the
 * permission of the page asking (dashboard, clients list, Client Due report),
 * so each needs only the permission its page already requires.
 */
export const agencyNetReceivableFn = createServerFn({ method: 'GET' })
  .validator(z.object({ view: z.enum(['dashboard', 'clients', 'reports']) }))
  .handler(async ({ data }): Promise<AgencyNetReceivable> => {
    const actor = await requireAdmin(AGENCY_VIEW_PERMISSION[data.view])
    const admin = getSupabaseAdminClient()
    const clients = await organizationClientDues(admin, actor.organizationId)
    const byClient = await netDueForClients(admin, clients, { live: true })
    return {
      totals: sumNetDueFigures([...byClient.values()]),
      byClient: Object.fromEntries(byClient),
    }
  })
