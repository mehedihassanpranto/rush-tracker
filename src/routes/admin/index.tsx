import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'

import {
  adminDashboardSectionsFn,
  adminDashboardStatsFn,
} from '@/server/dashboard/dashboard.fns'
import type { AdminDashboardStats } from '@/server/dashboard/dashboard.fns'
import { formatBdt, formatUsd } from '@/lib/money/money'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  EmptyState,
  SectionCard,
  actionLabel,
  relativeTime,
} from '@/components/dashboard/section'

export const Route = createFileRoute('/admin/')({
  component: AdminDashboard,
})

type StatKey = keyof AdminDashboardStats
type Money = 'bdt' | 'usd'

const SUMMARY_CARDS: Array<{ label: string; stat: StatKey; money?: Money }> = [
  { label: 'Total Clients', stat: 'totalClients' },
  { label: 'Active Ad Accounts', stat: 'activeAccounts' },
  { label: 'Available Ad Accounts', stat: 'availableAccounts' },
  { label: 'Pending Limit Requests', stat: 'pendingLimitRequests' },
  { label: 'Pending Payment Verifications', stat: 'pendingPaymentVerifications' },
  { label: 'Total Outstanding Due (BDT)', stat: 'totalOutstandingDueBdt', money: 'bdt' },
  { label: 'Total Outstanding Due (USD)', stat: 'totalOutstandingDueUsd', money: 'usd' },
  { label: "Today's Approved Limit (USD)", stat: 'todayApprovedLimitUsd', money: 'usd' },
  { label: "Today's Approved Billing (BDT)", stat: 'todayApprovedBillingBdt', money: 'bdt' },
  { label: "Today's Collection (BDT)", stat: 'todayCollectionBdt', money: 'bdt' },
]

function AdminDashboard() {
  const getStats = useServerFn(adminDashboardStatsFn)
  const getSections = useServerFn(adminDashboardSectionsFn)

  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-dashboard-stats'],
    queryFn: () => getStats(),
  })
  const { data: sections } = useQuery({
    queryKey: ['admin-dashboard-sections'],
    queryFn: () => getSections(),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Agency-wide overview. Figures are derived from the ledger.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {SUMMARY_CARDS.map((card) => {
          const raw = stats?.[card.stat]
          const display =
            raw === undefined
              ? '0'
              : card.money === 'bdt'
                ? formatBdt(raw)
                : card.money === 'usd'
                  ? formatUsd(raw)
                  : Number(raw).toLocaleString()
          return (
            <Card key={card.label}>
              <CardHeader className="pb-2">
                <CardDescription>{card.label}</CardDescription>
                <CardTitle className="text-2xl">
                  {isLoading ? <Skeleton className="h-8 w-16" /> : display}
                </CardTitle>
              </CardHeader>
              <CardContent />
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Pending Limit Requests"
          viewAll={{ to: '/admin/limit-requests' }}
        >
          {(sections?.pendingLimitRequests.length ?? 0) === 0 ? (
            <EmptyState text="No pending requests." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.pendingLimitRequests.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2">
                  <Link
                    to="/admin/limit-requests/$requestId"
                    params={{ requestId: r.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {r.request_number}
                  </Link>
                  <span className="text-muted-foreground">
                    {r.client?.name ?? '—'}
                  </span>
                  <span className="font-medium">
                    {formatUsd(r.requested_amount_usd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Pending Payment Verification"
          viewAll={{ to: '/admin/payments' }}
        >
          {(sections?.pendingPayments.length ?? 0) === 0 ? (
            <EmptyState text="No pending payments." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.pendingPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <Link
                    to="/admin/payments/$paymentId"
                    params={{ paymentId: p.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {p.payment_number}
                  </Link>
                  <span className="text-muted-foreground">
                    {p.client?.name ?? '—'}
                  </span>
                  <span className="font-medium">{formatBdt(p.amount_bdt)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Clients With Highest Due" viewAll={{ to: '/admin/clients' }}>
          {(sections?.topDueClients.length ?? 0) === 0 ? (
            <EmptyState text="No outstanding due." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.topDueClients.map((c) => (
                <li
                  key={c.client_id}
                  className="flex items-center justify-between py-2"
                >
                  <Link
                    to="/admin/clients/$clientId"
                    params={{ clientId: c.client_id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {c.name}
                  </Link>
                  <span className="font-medium">{formatBdt(c.current_due)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Recent Limit Approvals" viewAll={{ to: '/admin/limit-requests' }}>
          {(sections?.recentApprovals.length ?? 0) === 0 ? (
            <EmptyState text="No approvals yet." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.recentApprovals.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2">
                  <span className="text-muted-foreground">
                    {r.client?.name ?? '—'}
                  </span>
                  <span className="font-medium">
                    {formatBdt(r.bdt_charge ?? '0')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Recent Payments" viewAll={{ to: '/admin/payments' }}>
          {(sections?.recentPayments.length ?? 0) === 0 ? (
            <EmptyState text="No payments yet." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.recentPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <span className="text-muted-foreground">
                    {p.client?.name ?? '—'}
                  </span>
                  <span className="font-medium">{formatBdt(p.amount_bdt)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Recent Activity">
          {(sections?.recentActivity.length ?? 0) === 0 ? (
            <EmptyState text="No activity yet." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.recentActivity.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2">
                  <span>{actionLabel(a.action)}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.actor_name ? `${a.actor_name} · ` : ''}
                    {relativeTime(a.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
