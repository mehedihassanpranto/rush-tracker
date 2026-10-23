import { useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ArrowRight, Download, TriangleAlert } from 'lucide-react'

import {
  getAgencyFinanceSummaryFn,
  listAgencyMarginFn,
} from '@/server/agency-billing/agency-finance.fns'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { downloadCsv } from '@/lib/csv/csv'
import { fmtDateTime } from '@/components/platform/finance/format'
import { PlatformBillingPanel } from '@/components/agency/platform-billing-panel'
import type { MarginRow, MarginRowStatus } from '@/server/agency-billing/agency-finance.fns'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { StatusBadge } from '@/components/shared/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * The agency's Finance (owner decisions, 2026-10-23): its limits are sold from
 * the PLATFORM's pool accounts, so its money is
 *   clients pay the agency (their rate) → the agency owes the platform (its
 *   rate) → the difference is the agency's margin.
 * Everything comes from approvals, the client ledger and the platform's
 * charges/payments — nothing is typed in. Replaces the manual USD margin log
 * (never used) and absorbs Platform Billing (its "Pay the platform" tab).
 * SUPER_ADMIN only; every server fn re-checks.
 */
const TABS = ['overview', 'margin', 'platform'] as const
type Tab = (typeof TABS)[number]

export const Route = createFileRoute('/agency/finance/')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.includes(search.tab as Tab) ? (search.tab as Tab) : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (context.user?.role !== 'SUPER_ADMIN') throw redirect({ to: '/agency' })
  },
  component: AgencyFinancePage,
})

const dhakaMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }).slice(0, 7)
/** A YYYY-MM month as [start, start of next) in Asia/Dhaka (UTC+6, no DST). */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return {
    from: new Date(`${month}-01T00:00:00+06:00`).toISOString(),
    to: new Date(`${next}-01T00:00:00+06:00`).toISOString(),
  }
}

const STATUS: Record<MarginRowStatus, { badge: string; label: string }> = {
  PRICED: { badge: 'APPROVED', label: 'Billed by platform' },
  WAITING_RATE: { badge: 'PENDING', label: 'Waiting for your rate' },
  BEFORE_BILLING: { badge: 'INACTIVE', label: 'Before platform billing' },
  PLATFORM_REVERSED: { badge: 'REVERSED', label: 'Platform reversed' },
}

function AgencyFinancePage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab: Tab = search.tab ?? 'overview'
  const [month, setMonth] = useState(dhakaMonth())

  return (
    <div>
      <PageHeader
        title="Finance"
        description="Your clients pay you; you pay the platform for its ad accounts. The difference is your margin."
      />
      <Tabs value={tab} onValueChange={(t) => void navigate({ search: { tab: t === 'overview' ? undefined : (t as Tab) }, replace: true })}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="margin">Margin by approval</TabsTrigger>
          <TabsTrigger value="platform">Pay the platform</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-6">
          <MonthPicker month={month} onChange={setMonth} />
          <OverviewTab month={month} onPay={() => void navigate({ search: { tab: 'platform' } })} />
        </TabsContent>
        <TabsContent value="margin" className="space-y-6">
          <MonthPicker month={month} onChange={setMonth} />
          <MarginTab month={month} />
        </TabsContent>
        <TabsContent value="platform" className="space-y-6">
          <PlatformBillingPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor="finance-month" className="text-xs text-muted-foreground">
        Month
      </Label>
      <Input id="finance-month" type="month" className="w-44" value={month} max={dhakaMonth()} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </div>
  )
}

function OverviewTab({ month, onPay }: { month: string; onPay: () => void }) {
  const get = useServerFn(getAgencyFinanceSummaryFn)
  const q = useQuery({ queryKey: ['agency-finance', 'summary', month], queryFn: () => get({ data: monthRange(month) }) })
  const s = q.data
  const holding = s ? dec(s.collected_from_clients_bdt).minus(s.paid_to_platform_bdt) : null

  return (
    <>
      {!!q.error && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>Couldn't load your finance figures</AlertTitle>
          <AlertDescription>{q.error instanceof Error ? q.error.message : 'unknown error'}</AlertDescription>
        </Alert>
      )}
      {s && (s.waiting_rate > 0 || s.before_billing > 0) && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertTitle>Some approvals have no platform cost yet</AlertTitle>
          <AlertDescription>
            {s.waiting_rate > 0 && `${s.waiting_rate} are waiting for the platform to set your rate. `}
            {s.before_billing > 0 && `${s.before_billing} were approved before platform billing started on 21 Oct 2026. `}
            They're left out of the margin below.
          </AlertDescription>
        </Alert>
      )}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Margin</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Billed to clients"
            hint={s ? `${formatUsd(s.priced_usd)} of limits${s.avg_client_rate ? ` · ৳${s.avg_client_rate}/USD` : ''}` : 'Their rate'}
            value={s ? formatBdt(s.priced_client_bdt) : undefined}
            loading={q.isLoading}
          />
          <StatCard
            label="Owed to the platform"
            hint={s?.avg_platform_rate ? `Your rate · ৳${s.avg_platform_rate}/USD` : 'For the same limits, at your rate'}
            value={s ? formatBdt(s.owed_to_platform_bdt) : undefined}
            loading={q.isLoading}
          />
          <StatCard
            label="Your margin"
            hint={s && dec(s.priced_usd).gt(0) ? `৳${dec(s.margin_bdt).div(s.priced_usd).toFixed(2)} per USD` : 'Billed − owed'}
            value={s ? formatBdt(s.margin_bdt) : undefined}
            loading={q.isLoading}
            highlight
          />
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Cash this month</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Collected from clients" hint="All client payments" value={s ? formatBdt(s.collected_from_clients_bdt) : undefined} loading={q.isLoading} />
          <StatCard label="Paid to the platform" hint="Accepted payments" value={s ? formatBdt(s.paid_to_platform_bdt) : undefined} loading={q.isLoading} />
          <StatCard
            label="Collected − paid"
            hint="Cash this month that hasn't gone to the platform"
            value={holding ? formatBdt(holding.toFixed(2)) : undefined}
            loading={q.isLoading}
          />
        </div>
      </div>

      <Card className="flex-row flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <div className="text-sm text-muted-foreground">You owe the platform now</div>
          <div className="num text-2xl font-semibold">{s ? formatBdt(s.owed_to_platform_now_bdt) : '—'}</div>
          {s && dec(s.credit_with_platform_bdt).gt(0) && (
            <div className="text-xs text-muted-foreground">Credit with the platform: {formatBdt(s.credit_with_platform_bdt)}</div>
          )}
        </div>
        <Button onClick={onPay}>
          Pay the platform
          <ArrowRight className="size-4" />
        </Button>
      </Card>
      <p className="text-xs text-muted-foreground">
        You owe the platform for a limit as soon as it's approved on one of its ad accounts — whether or not
        the client has paid you yet. Margin counts only approvals the platform has priced.
      </p>
    </>
  )
}

function MarginTab({ month }: { month: string }) {
  const list = useServerFn(listAgencyMarginFn)
  const q = useQuery({ queryKey: ['agency-finance', 'margin', month], queryFn: () => list({ data: monthRange(month) }) })
  const rows = q.data ?? []

  function exportCsv(data: Array<MarginRow>) {
    downloadCsv(`margin-${month}.csv`, data, [
      { header: 'Approved', value: (r) => new Date(r.approved_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) },
      { header: 'Request', value: (r) => r.request_number },
      { header: 'Client', value: (r) => r.client },
      { header: 'Ad account', value: (r) => (r.ad_account ? `${r.ad_account.account_code} ${r.ad_account.name}` : '') },
      { header: 'USD', value: (r) => r.usd },
      { header: 'Client rate', value: (r) => r.client_rate ?? '' },
      { header: 'Billed to client (BDT)', value: (r) => r.client_bdt },
      { header: 'Your rate', value: (r) => r.platform_rate ?? '' },
      { header: 'Owed to platform (BDT)', value: (r) => r.platform_bdt ?? '' },
      { header: 'Margin (BDT)', value: (r) => r.margin_bdt ?? '' },
      { header: 'Status', value: (r) => STATUS[r.status].label },
    ])
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Approvals on platform ad accounts</h2>
        {rows.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => exportCsv(rows)}>
            <Download className="size-4" />
            Export CSV
          </Button>
        )}
      </div>
      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Approved</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">USD</TableHead>
              <TableHead className="text-right">Billed to client</TableHead>
              <TableHead className="text-right">Owed to platform</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!!q.error && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-destructive">
                  {q.error instanceof Error ? q.error.message : 'Could not load'}
                </TableCell>
              </TableRow>
            )}
            {!q.isLoading && !q.error && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  No limits approved on platform ad accounts this month.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.limit_request_id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.approved_at)}</TableCell>
                <TableCell className="whitespace-normal">
                  {r.client}
                  <div className="text-xs text-muted-foreground">
                    <span className="num">{r.request_number}</span>
                    {r.ad_account && ` · ${r.ad_account.account_code} · ${r.ad_account.name}`}
                  </div>
                </TableCell>
                <TableCell className="num text-right">{formatUsd(r.usd)}</TableCell>
                <TableCell className="num text-right">
                  {formatBdt(r.client_bdt)}
                  <div className="text-xs text-muted-foreground">
                    {r.client_reversed ? 'reversed for client' : r.client_rate ? `@ ৳${r.client_rate}` : ''}
                  </div>
                </TableCell>
                <TableCell className="num text-right">
                  {r.platform_bdt ? formatBdt(r.platform_bdt) : '—'}
                  {r.platform_rate && <div className="text-xs text-muted-foreground">@ ৳{r.platform_rate}</div>}
                </TableCell>
                <TableCell className={`num text-right font-medium ${r.margin_bdt && dec(r.margin_bdt).isNegative() ? 'text-danger' : ''}`}>
                  {r.margin_bdt ? formatBdt(r.margin_bdt) : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={STATUS[r.status].badge} label={STATUS[r.status].label} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
