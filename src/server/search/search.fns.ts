import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { PERMISSIONS } from '@/lib/permissions/permissions'

/**
 * Admin global search (spec §72). Server-side so it scales and respects the
 * authorization boundary. Matches across clients, ad accounts, and the
 * human-readable document numbers.
 */

export interface SearchResults {
  clients: Array<{ id: string; client_code: string; name: string }>
  accounts: Array<{
    id: string
    account_code: string
    name: string
    external_account_id: string | null
  }>
  limitRequests: Array<{ id: string; request_number: string; client_id: string }>
  payments: Array<{ id: string; payment_number: string; client_id: string }>
  paymentRequests: Array<{
    id: string
    request_number: string
    client_id: string
  }>
}

const EMPTY: SearchResults = {
  clients: [],
  accounts: [],
  limitRequests: [],
  payments: [],
  paymentRequests: [],
}

/** Escape PostgREST `or`/`ilike` wildcards and comma/paren separators. */
function sanitize(term: string): string {
  return term.replace(/[%,()]/g, ' ').trim()
}

export const globalSearchFn = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string() }))
  .handler(async ({ data }): Promise<SearchResults> => {
    await requireAdmin(PERMISSIONS.DASHBOARD_VIEW)
    const term = sanitize(data.q)
    if (term.length < 2) return EMPTY
    const admin = getSupabaseAdminClient()
    const like = `%${term}%`

    const [clients, accounts, limitRequests, payments, paymentRequests] =
      await Promise.all([
        admin
          .from('clients')
          .select('id, client_code, name')
          .or(`name.ilike.${like},client_code.ilike.${like}`)
          .limit(10),
        admin
          .from('ad_accounts')
          .select('id, account_code, name, external_account_id')
          .or(
            `name.ilike.${like},account_code.ilike.${like},external_account_id.ilike.${like}`,
          )
          .limit(10),
        admin
          .from('limit_requests')
          .select('id, request_number, client_id')
          .ilike('request_number', like)
          .limit(10),
        admin
          .from('payments')
          .select('id, payment_number, client_id')
          .ilike('payment_number', like)
          .limit(10),
        admin
          .from('payment_requests')
          .select('id, request_number, client_id')
          .ilike('request_number', like)
          .limit(10),
      ])

    return {
      clients: (clients.data ?? []) as SearchResults['clients'],
      accounts: (accounts.data ?? []) as SearchResults['accounts'],
      limitRequests: (limitRequests.data ?? []) as SearchResults['limitRequests'],
      payments: (payments.data ?? []) as SearchResults['payments'],
      paymentRequests: (paymentRequests.data ??
        []) as SearchResults['paymentRequests'],
    }
  })
