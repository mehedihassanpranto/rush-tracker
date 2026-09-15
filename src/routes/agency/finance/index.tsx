import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus, TrendingUp } from 'lucide-react'

import { listUsdMarginEntriesFn } from '@/server/finance/finance.fns'
import { dec, formatBdt } from '@/lib/money/money'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { CreateMarginEntryDialog } from '@/components/admin/finance/create-margin-entry-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { UsdMarginEntry } from '@/types/domain'

export const Route = createFileRoute('/agency/finance/')({
  component: FinancePage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ----------------------------------------------------------------------------
// Period grouping — buckets recorded entries into the granularity the owner
// asked to track: 15 days (semi-monthly, 1st-15th / 16th-end), weekly
// (Monday-start), monthly, half-yearly (Jan-Jun / Jul-Dec), yearly. Pure
// client-side grouping over the already-fetched list — no new query per
// granularity.
// ----------------------------------------------------------------------------

type Granularity = 'fifteen' | 'weekly' | 'monthly' | 'sixmonth' | 'yearly'

const GRANULARITY_OPTIONS: Array<{ value: Granularity; label: string }> = [
  { value: 'fifteen', label: '15 Days' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'sixmonth', label: '6 Months' },
  { value: 'yearly', label: 'Yearly' },
]

function bucketFor(
  dateStr: string,
  granularity: Granularity,
): { key: string; label: string } {
  const d = new Date(`${dateStr}T00:00:00`)
  const year = d.getFullYear()
  const month = d.getMonth()
  const day = d.getDate()
  const monthLabel = d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
  })

  switch (granularity) {
    case 'yearly':
      return { key: `${year}`, label: `${year}` }
    case 'sixmonth': {
      const half = month < 6 ? 'H1' : 'H2'
      return { key: `${year}-${half}`, label: `${half} ${year}` }
    }
    case 'monthly':
      return {
        key: `${year}-${String(month + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }),
      }
    case 'fifteen': {
      const half = day <= 15 ? '1-15' : '16-end'
      return {
        key: `${year}-${String(month + 1).padStart(2, '0')}-${day <= 15 ? 'A' : 'B'}`,
        label: `${monthLabel} (${half})`,
      }
    }
    case 'weekly': {
      const monday = new Date(d)
      const dow = (d.getDay() + 6) % 7 // 0 = Monday
      monday.setDate(d.getDate() - dow)
      const key = monday.toISOString().slice(0, 10)
      return {
        key,
        label: `Week of ${monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
      }
    }
  }
}

interface PeriodTotal {
  key: string
  label: string
  usd: ReturnType<typeof dec>
  buying: ReturnType<typeof dec>
  selling: ReturnType<typeof dec>
  margin: ReturnType<typeof dec>
}

function groupByPeriod(
  entries: Array<UsdMarginEntry>,
  granularity: Granularity,
): Array<PeriodTotal> {
  const buckets = new Map<string, PeriodTotal>()
  for (const e of entries) {
    const { key, label } = bucketFor(e.transaction_date, granularity)
    const existing = buckets.get(key)
    const usd = dec(e.usd_amount)
    const buying = dec(e.buying_amount_bdt)
    const selling = dec(e.selling_amount_bdt)
    const margin = dec(e.margin_bdt)
    if (existing) {
      existing.usd = existing.usd.plus(usd)
      existing.buying = existing.buying.plus(buying)
      existing.selling = existing.selling.plus(selling)
      existing.margin = existing.margin.plus(margin)
    } else {
      buckets.set(key, { key, label, usd, buying, selling, margin })
    }
  }
  return Array.from(buckets.values()).sort((a, b) => (a.key < b.key ? 1 : -1))
}

function FinancePage() {
  const { user } = Route.useRouteContext()
  const canView = hasPermission(user, PERMISSIONS.FINANCE_VIEW)
  const canManage = hasPermission(user, PERMISSIONS.FINANCE_MANAGE)

  const listEntries = useServerFn(listUsdMarginEntriesFn)
  const [createOpen, setCreateOpen] = useState(false)
  const [granularity, setGranularity] = useState<Granularity>('monthly')

  const { data: entries, isLoading } = useQuery({
    queryKey: ['usd-margin-entries'],
    queryFn: () => listEntries(),
    enabled: canView,
  })

  const totalMargin = (entries ?? []).reduce(
    (sum, e) => sum.plus(dec(e.margin_bdt)),
    dec(0),
  )

  const periods = useMemo(
    () => groupByPeriod(entries ?? [], granularity),
    [entries, granularity],
  )

  if (!canView) {
    return (
      <div>
        <PageHeader
          title="Finance"
          description="USD buy/sell margin tracking."
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <TrendingUp className="size-8 opacity-40" />
            You don&apos;t have access to finance data. Ask a Super Admin to
            grant the &quot;finance.view&quot; permission from Users.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Finance"
        description="USD buy/sell margin — what you paid for dollars vs. what they sold for."
      >
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New entry
          </Button>
        )}
      </PageHeader>

      <Card className="mb-6">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Total margin recorded</CardTitle>
        </CardHeader>
        <CardContent>
          <p
            className={
              totalMargin.isNegative()
                ? 'text-3xl font-semibold text-danger'
                : 'text-3xl font-semibold text-success'
            }
          >
            {formatBdt(totalMargin)}
          </p>
        </CardContent>
      </Card>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Margin by period</h2>
        <Select
          value={granularity}
          onValueChange={(v) => setGranularity(v as Granularity)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GRANULARITY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="mb-8 p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">USD amount</TableHead>
              <TableHead className="text-right">Buying</TableHead>
              <TableHead className="text-right">Selling</TableHead>
              <TableHead className="text-right">Margin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && periods.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <TrendingUp className="size-8 opacity-40" />
                    No entries yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {periods.map((p) => (
              <TableRow key={p.key}>
                <TableCell className="font-medium">{p.label}</TableCell>
                <TableCell className="text-right">${p.usd.toFixed(2)}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatBdt(p.buying)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatBdt(p.selling)}
                </TableCell>
                <TableCell
                  className={
                    p.margin.isNegative()
                      ? 'text-right font-medium text-danger'
                      : 'text-right font-medium text-success'
                  }
                >
                  {formatBdt(p.margin)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <h2 className="mb-3 text-lg font-semibold">All entries</h2>
      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">USD amount</TableHead>
              <TableHead className="text-right">Buying</TableHead>
              <TableHead className="text-right">Selling</TableHead>
              <TableHead className="text-right">Margin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (entries?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <TrendingUp className="size-8 opacity-40" />
                    No entries yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {entries?.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(e.transaction_date)}
                </TableCell>
                <TableCell className="text-right">
                  ${dec(e.usd_amount).toFixed(2)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatBdt(e.buying_amount_bdt)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatBdt(e.selling_amount_bdt)}
                </TableCell>
                <TableCell
                  className={
                    dec(e.margin_bdt).isNegative()
                      ? 'text-right font-medium text-danger'
                      : 'text-right font-medium text-success'
                  }
                >
                  {formatBdt(e.margin_bdt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <CreateMarginEntryDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
