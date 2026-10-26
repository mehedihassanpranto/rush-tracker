import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import {
  agencyPeriodTotalsFn,
  clientPeriodTotalsFn,
  refreshAgencySpendFn,
  refreshClientSpendFn,
} from '@/server/dashboard/dashboard-period.fns'
import { DASHBOARD_PERIODS, PERIOD_LABELS } from '@/lib/dashboard/periods'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { relativeTime } from '@/components/dashboard/section'
import type { DashboardPeriod } from '@/lib/dashboard/periods'
import { StatCard } from '@/components/shared/stat-card'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * Dashboards (owner request, 2026-10-23): USD spent on Meta, limits approved
 * and payments for today / yesterday (added 2026-10-26) / this week (from
 * Sunday) / this month / last month — totals, then day by day (for periods
 * longer than a day). Spend is Meta's own daily figure, cached; Refresh
 * fetches it again (at most once a minute). `agency` covers the
 * agency's accounts and all its clients' payments; `client` only the client
 * being viewed (its accounts while assigned to it, its own payments).
 */
export function PeriodSection({ audience }: { audience: 'agency' | 'client' }) {
  const queryClient = useQueryClient()
  const getAgency = useServerFn(agencyPeriodTotalsFn)
  const getClient = useServerFn(clientPeriodTotalsFn)
  const refreshAgency = useServerFn(refreshAgencySpendFn)
  const refreshClient = useServerFn(refreshClientSpendFn)
  const [period, setPeriod] = useState<DashboardPeriod>('today')
  const queryKey = [`${audience}-dashboard-period`, period]

  const q = useQuery({
    queryKey,
    queryFn: () => (audience === 'agency' ? getAgency({ data: { period } }) : getClient({ data: { period } })),
  })
  const r = q.data
  const refreshMut = useMutation({
    mutationFn: () => (audience === 'agency' ? refreshAgency() : refreshClient()),
    onSuccess: (res) => {
      toast.success(
        res.refreshed > 0
          ? `Spend updated from Meta for ${res.refreshed} account${res.refreshed === 1 ? '' : 's'}${res.failed ? ` (${res.failed} couldn't be read)` : ''}`
          : res.failed > 0
            ? 'Meta could not be reached — showing the last saved figures'
            : 'No ad accounts linked to Meta yet',
      )
      void queryClient.invalidateQueries({ queryKey: [`${audience}-dashboard-period`] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Five periods don't fit one row on a phone: an even 3 + 2 grid there,
            one row from sm up. */}
        <div className="grid w-full grid-cols-3 rounded-lg bg-muted p-1 sm:inline-flex sm:w-auto" role="group" aria-label="Period">
          {DASHBOARD_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
              className={cn(
                'whitespace-nowrap rounded-md px-3 py-1.5 text-center text-sm font-medium transition-colors',
                period === p ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {r?.spend.as_of ? `Meta spend as of ${relativeTime(r.spend.as_of)}` : 'Meta spend not fetched yet'}
          <Button size="sm" variant="outline" disabled={refreshMut.isPending} onClick={() => refreshMut.mutate()}>
            {refreshMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="USD spent"
          hint={r ? `On Meta, ${r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(r.to)}`}` : 'On Meta'}
          value={r ? formatUsd(r.totals.spend_usd) : undefined}
          loading={q.isLoading}
          highlight
        />
        <StatCard
          label="Limit approved"
          hint={r ? `Billed ${formatBdt(r.totals.approved_billing_bdt)}` : 'USD'}
          value={r ? formatUsd(r.totals.approved_limit_usd) : undefined}
          loading={q.isLoading}
        />
        <StatCard
          label={audience === 'agency' ? 'Paid by clients' : 'You paid'}
          hint={audience === 'agency' ? 'Payments received' : 'Payments accepted'}
          value={r ? formatBdt(r.totals.collection_bdt) : undefined}
          loading={q.isLoading}
        />
      </div>
      {r && r.spend.non_usd_accounts > 0 && (
        <p className="text-xs text-muted-foreground">
          {r.spend.non_usd_accounts} account{r.spend.non_usd_accounts === 1 ? '' : 's'} spend in another currency and
          {r.spend.non_usd_accounts === 1 ? ' is' : ' are'} not in the USD total.
        </p>
      )}

      {r && r.from !== r.to && (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">USD spent</TableHead>
                <TableHead className="text-right">Limit approved</TableHead>
                <TableHead className="text-right">{audience === 'agency' ? 'Paid by clients' : 'You paid'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.days.map((d) => (
                <TableRow key={d.date}>
                  <TableCell className="whitespace-nowrap">{fmtDay(d.date)}</TableCell>
                  <TableCell className="num text-right">{d.spend_usd === '0.00' ? '—' : formatUsd(d.spend_usd)}</TableCell>
                  <TableCell className="num text-right">{d.approved_limit_usd === '0.00' ? '—' : formatUsd(d.approved_limit_usd)}</TableCell>
                  <TableCell className="num text-right">{d.collection_bdt === '0.00' ? '—' : formatBdt(d.collection_bdt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  )
}
