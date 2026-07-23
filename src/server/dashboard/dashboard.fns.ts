import { createServerFn } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin, requireClientMembership } from '@/server/auth/guards.server'
import { bdtToUsd, currentUsdRate } from '@/server/exchange-rates/rate.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import type {
  AdAccount,
  LedgerEntry,
  LimitRequestWithRefs,
  Payment,
  PaymentRequest,
  PaymentWithClient,
} from '@/types/domain'

const LR_SELECT =
  '*, client:clients(id, client_code, name), ad_account:ad_accounts(id, account_code, name)'
const PAY_SELECT =
  'id, payment_number, client_id, payment_request_id, amount_bdt, payment_method, transaction_reference, status, submitted_at, reviewed_at, admin_note, rejection_reason, created_at, client:clients(id, client_code, name)'

export interface AdminDashboardStats {
  totalClients: number
  activeAccounts: number
  availableAccounts: number
  pendingLimitRequests: number
  pendingPaymentVerifications: number
  totalOutstandingDueBdt: string
  totalOutstandingDueUsd: string
  todayApprovedLimitUsd: string
  todayApprovedBillingBdt: string
  todayCollectionBdt: string
}

/** Live counts derivable from data available so far (spec §65). Financial
 *  cards arrive with their phases. */
export const adminDashboardStatsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminDashboardStats> => {
    await requireAdmin(PERMISSIONS.DASHBOARD_VIEW)
    const admin = getSupabaseAdminClient()

    const [clients, active, available, pending, pendingPay, due] =
      await Promise.all([
        admin.from('clients').select('*', { count: 'exact', head: true }),
        admin
          .from('ad_accounts')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'ACTIVE'),
        admin
          .from('ad_accounts')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'AVAILABLE'),
        admin
          .from('limit_requests')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'PENDING'),
        admin
          .from('payments')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'PENDING'),
        admin.rpc('total_outstanding_due'),
      ])

    const dueBdt = String(due.data ?? '0')
    const rate = await currentUsdRate()

    const { data: todayData } = await admin.rpc('admin_today_totals')
    const today = (
      todayData as Array<{
        approved_limit_usd: string
        approved_billing_bdt: string
        collection_bdt: string
      }> | null
    )?.[0]

    return {
      totalClients: clients.count ?? 0,
      activeAccounts: active.count ?? 0,
      availableAccounts: available.count ?? 0,
      pendingLimitRequests: pending.count ?? 0,
      pendingPaymentVerifications: pendingPay.count ?? 0,
      totalOutstandingDueBdt: dueBdt,
      totalOutstandingDueUsd: bdtToUsd(dueBdt, rate),
      todayApprovedLimitUsd: today?.approved_limit_usd ?? '0',
      todayApprovedBillingBdt: today?.approved_billing_bdt ?? '0',
      todayCollectionBdt: today?.collection_bdt ?? '0',
    }
  },
)

export interface ClientDashboardStats {
  activeAccounts: number
  pendingLimitRequests: number
  totalBilledBdt: string
  totalPaidBdt: string
  currentDueBdt: string
  currentDueUsd: string
  totalApprovedUsd: string
}

export const clientDashboardStatsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ClientDashboardStats> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()

    const [accounts, pending, financials] = await Promise.all([
      admin
        .from('ad_account_assignments')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', membership.clientId)
        .eq('status', 'ACTIVE'),
      admin
        .from('limit_requests')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', membership.clientId)
        .eq('status', 'PENDING'),
      admin.rpc('client_financials', { p_client_id: membership.clientId }),
    ])

    const fin = (
      financials.data as
        | Array<{
            total_debit: string
            total_credit: string
            current_due: string
            total_approved_usd: string
          }>
        | null
    )?.[0]

    const currentDueBdt = fin?.current_due ?? '0'
    const rate = await currentUsdRate()

    return {
      activeAccounts: accounts.count ?? 0,
      pendingLimitRequests: pending.count ?? 0,
      totalBilledBdt: fin?.total_debit ?? '0',
      totalPaidBdt: fin?.total_credit ?? '0',
      currentDueBdt,
      currentDueUsd: bdtToUsd(currentDueBdt, rate),
      totalApprovedUsd: fin?.total_approved_usd ?? '0',
    }
  },
)

// ===========================================================================
// Dashboard sections (spec §65, §66)
// ===========================================================================

export interface TopDueClient {
  client_id: string
  client_code: string
  name: string
  current_due: string
}

export interface ActivityItem {
  id: string
  action: string
  entity_type: string
  entity_id: string | null
  created_at: string
  actor_name: string | null
}

export interface AdminDashboardSections {
  pendingLimitRequests: Array<LimitRequestWithRefs>
  pendingPayments: Array<PaymentWithClient>
  topDueClients: Array<TopDueClient>
  recentApprovals: Array<LimitRequestWithRefs>
  recentPayments: Array<PaymentWithClient>
  recentActivity: Array<ActivityItem>
}

export const adminDashboardSectionsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminDashboardSections> => {
    await requireAdmin(PERMISSIONS.DASHBOARD_VIEW)
    const admin = getSupabaseAdminClient()

    const [
      pendingLR,
      pendingPay,
      topDue,
      recentApprovals,
      recentPayments,
      activity,
    ] = await Promise.all([
      admin
        .from('limit_requests')
        .select(LR_SELECT)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false })
        .limit(5),
      admin
        .from('payments')
        .select(PAY_SELECT)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false })
        .limit(5),
      admin.rpc('top_due_clients', { p_limit: 5 }),
      admin
        .from('limit_requests')
        .select(LR_SELECT)
        .eq('status', 'APPROVED')
        .order('approved_at', { ascending: false })
        .limit(5),
      admin
        .from('payments')
        .select(PAY_SELECT)
        .eq('status', 'APPROVED')
        .order('reviewed_at', { ascending: false })
        .limit(5),
      admin
        .from('audit_logs')
        .select('id, action, entity_type, entity_id, created_at, actor_user_id')
        .order('created_at', { ascending: false })
        .limit(10),
    ])

    // Resolve actor names for the activity feed.
    const activityRows = (activity.data ?? []) as Array<{
      id: string
      action: string
      entity_type: string
      entity_id: string | null
      created_at: string
      actor_user_id: string | null
    }>
    const actorIds = [
      ...new Set(activityRows.map((a) => a.actor_user_id).filter(Boolean)),
    ] as Array<string>
    const nameById = new Map<string, string>()
    if (actorIds.length > 0) {
      const { data: profiles } = await admin
        .from('user_profiles')
        .select('user_id, full_name')
        .in('user_id', actorIds)
      for (const p of (profiles ?? []) as Array<{
        user_id: string
        full_name: string
      }>) {
        nameById.set(p.user_id, p.full_name)
      }
    }

    return {
      pendingLimitRequests: (pendingLR.data ??
        []) as unknown as Array<LimitRequestWithRefs>,
      pendingPayments: (pendingPay.data ??
        []) as unknown as Array<PaymentWithClient>,
      topDueClients: ((topDue.data ?? []) as Array<TopDueClient>).map((r) => ({
        ...r,
        current_due: String(r.current_due),
      })),
      recentApprovals: (recentApprovals.data ??
        []) as unknown as Array<LimitRequestWithRefs>,
      recentPayments: (recentPayments.data ??
        []) as unknown as Array<PaymentWithClient>,
      recentActivity: activityRows.map((a) => ({
        id: a.id,
        action: a.action,
        entity_type: a.entity_type,
        entity_id: a.entity_id,
        created_at: a.created_at,
        actor_name: a.actor_user_id
          ? (nameById.get(a.actor_user_id) ?? null)
          : null,
      })),
    }
  },
)

export interface ClientDashboardSections {
  accounts: Array<AdAccount>
  pendingLimitRequests: Array<LimitRequestWithRefs>
  paymentRequests: Array<PaymentRequest>
  recentPayments: Array<Payment>
  recentTransactions: Array<LedgerEntry>
}

const OPEN_PR_STATUSES = ['REQUESTED', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID']

export const clientDashboardSectionsFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<ClientDashboardSections> => {
  const { membership } = await requireClientMembership()
  const admin = getSupabaseAdminClient()
  const cid = membership.clientId

  const [assignments, pendingLR, paymentRequests, recentPayments, recentTx] =
    await Promise.all([
      admin
        .from('ad_account_assignments')
        .select('account:ad_accounts(*)')
        .eq('client_id', cid)
        .eq('status', 'ACTIVE')
        .limit(6),
      admin
        .from('limit_requests')
        .select(LR_SELECT)
        .eq('client_id', cid)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false })
        .limit(5),
      admin
        .from('payment_requests')
        .select(
          'id, request_number, client_id, requested_amount_bdt, status, message, due_date, created_at',
        )
        .eq('client_id', cid)
        .in('status', OPEN_PR_STATUSES)
        .order('created_at', { ascending: false })
        .limit(5),
      admin
        .from('payments')
        .select(
          'id, payment_number, client_id, payment_request_id, amount_bdt, payment_method, transaction_reference, status, submitted_at, reviewed_at, admin_note, rejection_reason, created_at',
        )
        .eq('client_id', cid)
        .order('created_at', { ascending: false })
        .limit(5),
      admin
        .from('ledger_entries')
        .select(
          'id, transaction_number, client_id, type, reference_type, reference_id, usd_amount, usd_rate, bdt_amount, debit_bdt, credit_bdt, description, created_at',
        )
        .eq('client_id', cid)
        .order('created_at', { ascending: false })
        .limit(5),
    ])

  const accounts = ((assignments.data ?? []) as unknown as Array<{
    account: AdAccount | null
  }>)
    .map((r) => r.account)
    .filter((a): a is AdAccount => a !== null)

  return {
    accounts,
    pendingLimitRequests: (pendingLR.data ??
      []) as unknown as Array<LimitRequestWithRefs>,
    paymentRequests: (paymentRequests.data ?? []) as Array<PaymentRequest>,
    recentPayments: (recentPayments.data ?? []) as Array<Payment>,
    recentTransactions: (recentTx.data ?? []) as Array<LedgerEntry>,
  }
})
