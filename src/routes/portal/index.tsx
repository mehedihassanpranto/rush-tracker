import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'

import { activeMemberships } from '@/lib/auth/types'
import {
  clientDashboardSectionsFn,
  clientDashboardStatsFn,
} from '@/server/dashboard/dashboard.fns'
import type { ClientDashboardStats } from '@/server/dashboard/dashboard.fns'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/shared/status-badge'
import { EmptyState, SectionCard } from '@/components/dashboard/section'

export const Route = createFileRoute('/portal/')({
  component: ClientDashboard,
})

type StatKey = keyof ClientDashboardStats
type Money = 'bdt' | 'usd'

const SUMMARY_CARDS: Array<{ label: string; stat: StatKey; money?: Money }> = [
  { label: 'Active Ad Accounts', stat: 'activeAccounts' },
  { label: 'Pending Limit Requests', stat: 'pendingLimitRequests' },
  { label: 'Total Approved Limit (USD)', stat: 'totalApprovedUsd', money: 'usd' },
  { label: 'Total Billed (BDT)', stat: 'totalBilledBdt', money: 'bdt' },
  { label: 'Total Paid (BDT)', stat: 'totalPaidBdt', money: 'bdt' },
  { label: 'Current Due (BDT)', stat: 'currentDueBdt', money: 'bdt' },
  { label: 'Current Due (USD, approx.)', stat: 'currentDueUsd', money: 'usd' },
]

function ClientDashboard() {
  const { user } = Route.useRouteContext()
  const memberships = activeMemberships(user)
  const getStats = useServerFn(clientDashboardStatsFn)
  const getSections = useServerFn(clientDashboardSectionsFn)

  const { data: stats, isLoading } = useQuery({
    queryKey: ['client-dashboard-stats'],
    queryFn: () => getStats(),
  })
  const { data: sections } = useQuery({
    queryKey: ['client-dashboard-sections'],
    queryFn: () => getSections(),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {memberships.map((m) => (
            <span key={m.clientId} className="flex items-center gap-2">
              {m.clientName}
              <Badge variant="secondary">{m.clientCode}</Badge>
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SUMMARY_CARDS.map((card) => {
          const raw = stats?.[card.stat]
          const display =
            raw === undefined
              ? '—'
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
                  {isLoading ? <Skeleton className="h-8 w-20" /> : display}
                </CardTitle>
              </CardHeader>
              <CardContent />
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="My Ad Accounts" viewAll={{ to: '/portal/ad-accounts' }}>
          {(sections?.accounts.length ?? 0) === 0 ? (
            <EmptyState text="No ad accounts assigned." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.accounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2">
                  <span className="font-medium">{a.name}</span>
                  <span className="flex items-center gap-2">
                    {formatUsd(a.current_limit_usd)}
                    <StatusBadge status={a.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Pending Limit Requests"
          viewAll={{ to: '/portal/limit-requests' }}
        >
          {(sections?.pendingLimitRequests.length ?? 0) === 0 ? (
            <EmptyState text="No pending requests." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.pendingLimitRequests.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2">
                  <span className="font-mono text-xs">{r.request_number}</span>
                  <span className="text-muted-foreground">
                    {r.ad_account?.name ?? '—'}
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
          title="Payment Requests"
          viewAll={{ to: '/portal/payment-requests' }}
        >
          {(sections?.paymentRequests.length ?? 0) === 0 ? (
            <EmptyState text="No open payment requests." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.paymentRequests.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2">
                  <span className="font-mono text-xs">{r.request_number}</span>
                  <span className="font-medium">
                    {formatBdt(r.requested_amount_bdt)}
                  </span>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Recent Payments" viewAll={{ to: '/portal/due' }}>
          {(sections?.recentPayments.length ?? 0) === 0 ? (
            <EmptyState text="No payments yet." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.recentPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <span className="font-mono text-xs">{p.payment_number}</span>
                  <span className="font-medium">{formatBdt(p.amount_bdt)}</span>
                  <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Recent Transactions" viewAll={{ to: '/portal/statement' }}>
          {(sections?.recentTransactions.length ?? 0) === 0 ? (
            <EmptyState text="No transactions yet." />
          ) : (
            <ul className="divide-y text-sm">
              {sections?.recentTransactions.map((e) => (
                <li key={e.id} className="flex items-center justify-between py-2">
                  <StatusBadge status={e.type} />
                  <span className="text-muted-foreground">
                    {e.description ?? '—'}
                  </span>
                  <span className="font-medium">
                    {Number(e.debit_bdt) > 0
                      ? `+${formatBdt(e.debit_bdt)}`
                      : `−${formatBdt(e.credit_bdt)}`}
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
