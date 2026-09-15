import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'

import { activeMemberships } from '@/lib/auth/types'
import {
  clientDashboardSectionsFn,
  clientDashboardStatsFn,
} from '@/server/dashboard/dashboard.fns'
import type { ClientDashboardStats } from '@/server/dashboard/dashboard.fns'
import { listMyAccountsMetaRemainingFn } from '@/server/meta/meta.fns'
import { setActiveClientFn } from '@/server/auth/portal-session.fns'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/shared/stat-card'
import { StatusBadge } from '@/components/shared/status-badge'
import { EmptyState, SectionCard } from '@/components/dashboard/section'

export const Route = createFileRoute('/client/')({
  component: ClientDashboard,
})

type StatKey = keyof ClientDashboardStats
type Money = 'bdt' | 'usd'

const SUMMARY_CARDS: Array<{
  label: string
  stat: StatKey
  money?: Money
  dueStyle?: boolean
}> = [
  { label: 'Active Ad Accounts', stat: 'activeAccounts' },
  { label: 'Pending Limit Requests', stat: 'pendingLimitRequests' },
  { label: 'Total Approved Limit (USD)', stat: 'totalApprovedUsd', money: 'usd' },
  { label: 'Total Billed (BDT)', stat: 'totalBilledBdt', money: 'bdt' },
  { label: 'Total Paid (BDT)', stat: 'totalPaidBdt', money: 'bdt' },
  { label: 'Current Due (BDT)', stat: 'currentDueBdt', money: 'bdt', dueStyle: true },
  {
    label: 'Current Due (USD, approx.)',
    stat: 'currentDueUsd',
    money: 'usd',
    dueStyle: true,
  },
]

function ClientDashboard() {
  const { user } = Route.useRouteContext()
  const memberships = activeMemberships(user)
  const getStats = useServerFn(clientDashboardStatsFn)
  const getSections = useServerFn(clientDashboardSectionsFn)
  const listRemaining = useServerFn(listMyAccountsMetaRemainingFn)
  const switchClient = useServerFn(setActiveClientFn)

  // A hard navigation, not router.invalidate() — every query on every
  // portal page keys off the server-side active-client cookie, not a
  // clientId in the query key, so a full reload is what guarantees nothing
  // stale from the previous client survives in the TanStack Query cache.
  const switchMutation = useMutation({
    mutationFn: (clientId: string) =>
      switchClient({ data: { client_id: clientId } }),
    onSuccess: () => {
      window.location.assign('/client')
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to switch client'),
  })

  const { data: stats, isLoading } = useQuery({
    queryKey: ['client-dashboard-stats'],
    queryFn: () => getStats(),
  })
  const { data: sections } = useQuery({
    queryKey: ['client-dashboard-sections'],
    queryFn: () => getSections(),
  })
  // Same query the ad-accounts page uses for its per-row "Remaining" column
  // (best-effort — '—' rather than breaking the page if Meta is
  // unreachable/unconfigured), summed here across all this client's own
  // USD-linked accounts for one total-headroom figure.
  const { data: remaining } = useQuery({
    queryKey: ['my-accounts-meta-remaining'],
    queryFn: () => listRemaining(),
    retry: false,
    throwOnError: false,
  })
  const totalRemainingUsd =
    remaining !== undefined
      ? remaining
          .reduce((sum, r) => {
            if (r.remaining == null || r.currency !== 'USD') return sum
            return sum.plus(dec(r.remaining))
          }, dec(0))
          .toFixed(2)
      : null
  // Sum of Meta Due (balance owed to Meta) across this client's own
  // USD-currency linked accounts — same no-FX, currency-native gate as
  // Total Remaining above.
  const totalMetaDueUsd =
    remaining !== undefined
      ? remaining
          .reduce((sum, r) => {
            if (r.meta_balance == null || r.currency !== 'USD') return sum
            return sum.plus(dec(r.meta_balance))
          }, dec(0))
          .toFixed(2)
      : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        {memberships.length > 1 ? (
          <>
            <p className="mt-1 text-xs text-muted-foreground">
              You have access to {memberships.length} clients — click one to
              switch.
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
              {memberships.map((m) => {
                const isActive = m.clientId === user.activeClientId
                return (
                  <button
                    key={m.clientId}
                    type="button"
                    disabled={isActive || switchMutation.isPending}
                    onClick={() => switchMutation.mutate(m.clientId)}
                    className={cn(
                      'flex items-center gap-2 rounded-full border px-2.5 py-1 transition-colors',
                      isActive
                        ? 'border-primary bg-primary/10 font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:border-border hover:bg-accent disabled:opacity-50',
                    )}
                  >
                    {m.clientName}
                    <Badge variant="secondary">{m.clientCode}</Badge>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {memberships.map((m) => (
              <span key={m.clientId} className="flex items-center gap-2">
                {m.clientName}
                <Badge variant="secondary">{m.clientCode}</Badge>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 3 columns, not 4: with 7-9 tiles (the two Meta ones are
          conditional) a 4-up grid consistently left one card stranded
          alone on the last row. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          const dueColor =
            card.dueStyle && raw !== undefined
              ? Number(raw) > 0
                ? 'text-red-600 dark:text-red-400'
                : 'text-emerald-600 dark:text-emerald-400'
              : ''
          return (
            <StatCard
              key={card.label}
              label={card.label}
              value={display}
              valueClassName={dueColor}
              loading={isLoading}
            />
          )
        })}
        {totalRemainingUsd !== null && (
          <StatCard
            label="Total Remaining"
            hint="Meta spend headroom across your ad accounts"
            value={formatUsd(totalRemainingUsd)}
          />
        )}
        {totalMetaDueUsd !== null && (
          <StatCard
            label="Meta Due"
            hint="Balance owed to Meta across your ad accounts"
            value={formatUsd(totalMetaDueUsd)}
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="My Ad Accounts" viewAll={{ to: '/client/ad-accounts' }}>
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
          viewAll={{ to: '/client/limit-requests' }}
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
          viewAll={{ to: '/client/payment-requests' }}
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

        <SectionCard title="Recent Payments" viewAll={{ to: '/client/due' }}>
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

        <SectionCard title="Recent Transactions" viewAll={{ to: '/client/statement' }}>
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
