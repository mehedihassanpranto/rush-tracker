import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Download } from 'lucide-react'

import { getProfitReportFn } from '@/server/platform/finance-close.fns'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { downloadCsv } from '@/lib/csv/csv'
import { fmtRate } from '@/components/platform/finance/format'
import type { ProfitReport } from '@/server/platform/finance-close.fns'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

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

/**
 * Finance v2 Milestone 5: profit for a month, by event date. Revenue is billed
 * at approval but Meta's cost lands when the bill is paid (or prepaid spend is
 * read), so "costs still to come" is shown beside the figure, not hidden.
 * Per-agency cost is an estimate: the spend read on accounts it held × the
 * month's Meta cost per dollar.
 */
export function ProfitTab() {
  const get = useServerFn(getProfitReportFn)
  const [month, setMonth] = useState(dhakaMonth())
  const range = month ? monthRange(month) : null
  const q = useQuery({
    queryKey: ['platform-usd', 'profit', month],
    queryFn: () => get({ data: range! }),
    enabled: !!range,
  })
  const r = q.data
  const perUsd = r?.period_cost_per_usd ?? r?.avg_stock_cost ?? null

  function exportCsv(rep: ProfitReport) {
    downloadCsv(`profit-${month}.csv`, rep.agencies, [
      { header: 'Agency', value: (a) => a.name },
      { header: 'Billed USD', value: (a) => a.billed_usd },
      { header: 'Revenue BDT', value: (a) => a.revenue_bdt },
      { header: 'Meta spend USD', value: (a) => a.spend_usd },
      { header: 'Est. cost BDT', value: (a) => a.est_cost_bdt ?? '' },
      { header: 'Est. margin BDT', value: (a) => a.est_margin_bdt ?? '' },
    ])
  }

  const line = (label: string, value: string, opts?: { strong?: boolean; minus?: boolean; hint?: string }) => (
    <TableRow className={opts?.strong ? 'font-medium' : undefined}>
      <TableCell>
        {label}
        {opts?.hint && <div className="text-xs font-normal text-muted-foreground">{opts.hint}</div>}
      </TableCell>
      <TableCell className="num text-right">
        {opts?.minus && dec(value).gt(0) ? '−' : ''}
        {formatBdt(value)}
      </TableCell>
    </TableRow>
  )

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor="profit-month" className="text-xs text-muted-foreground">
            Month
          </Label>
          <Input id="profit-month" type="month" className="w-44" value={month} max={dhakaMonth()} onChange={(e) => setMonth(e.target.value)} />
        </div>
        {r && (
          <Button size="sm" variant="outline" onClick={() => exportCsv(r)}>
            <Download className="size-4" />
            Export CSV
          </Button>
        )}
      </div>

      <Card className="p-0">
        <Table>
          <TableBody>
            {q.isLoading && (
              <TableRow>
                <TableCell colSpan={2}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!!q.error && (
              <TableRow>
                <TableCell colSpan={2} className="py-8 text-center text-sm text-destructive">
                  {q.error instanceof Error ? q.error.message : 'Could not load'}
                </TableCell>
              </TableRow>
            )}
            {r && (
              <>
                {line('Revenue', r.revenue_bdt, { hint: 'Pool-account approvals billed to agencies' })}
                {line('Meta cost', r.meta_cost_bdt, {
                  minus: true,
                  hint: `${formatUsd(r.meta_cost_usd)} of Meta bills paid and prepaid spend, at FIFO cost`,
                })}
                {dec(r.write_off_bdt).gt(0) && line('Prepaid credit written off', r.write_off_bdt, { minus: true })}
                {line('Gross profit', r.gross_profit_bdt, { strong: true })}
                {dec(r.other_bdt).gt(0) && line('Other USD outflows', r.other_bdt, { minus: true })}
                {dec(r.other_bdt).gt(0) && line('After other outflows', r.net_after_other_bdt, { strong: true })}
              </>
            )}
          </TableBody>
        </Table>
      </Card>

      {r && (
        <Card className="space-y-1 p-4 text-sm">
          <div className="font-medium">Costs still to come (as of now)</div>
          <p className="text-muted-foreground">
            {formatUsd(r.unpaid_meta_usd)} of Meta spend whose bill isn't paid yet, and {formatUsd(r.billed_unspent_usd)}{' '}
            billed to agencies that Meta hasn't spent yet. Their revenue is already counted; their cost isn't.
            {perUsd && dec(r.unpaid_meta_usd).plus(r.billed_unspent_usd).gt(0) && (
              <>
                {' '}At ৳{fmtRate(perUsd)} per dollar that is about{' '}
                <span className="font-medium text-foreground">
                  {formatBdt(dec(r.unpaid_meta_usd).plus(r.billed_unspent_usd).mul(perUsd).toFixed(2))}
                </span>
                .
              </>
            )}
          </p>
        </Card>
      )}

      <div>
        <h2 className="mb-3 text-lg font-semibold">By agency</h2>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agency</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Meta spend</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
                <TableHead className="text-right">Est. margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r?.agencies.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    Nothing billed or spent this month.
                  </TableCell>
                </TableRow>
              )}
              {r?.agencies.map((a) => (
                <TableRow key={a.organization_id ?? 'none'}>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell className="num text-right">{formatUsd(a.billed_usd)}</TableCell>
                  <TableCell className="num text-right">{formatBdt(a.revenue_bdt)}</TableCell>
                  <TableCell className="num text-right">{formatUsd(a.spend_usd)}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">{a.est_cost_bdt ? formatBdt(a.est_cost_bdt) : '—'}</TableCell>
                  <TableCell className={`num text-right font-medium ${a.est_margin_bdt && dec(a.est_margin_bdt).isNegative() ? 'text-danger' : ''}`}>
                    {a.est_margin_bdt ? formatBdt(a.est_margin_bdt) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        <p className="mt-2 text-xs text-muted-foreground">
          Estimated: an agency's cost is the Meta spend read on accounts it held this month ×{' '}
          {perUsd ? `৳${fmtRate(perUsd)}` : 'the cost per dollar'} (this month's Meta cost per dollar, or the
          stock's average cost when nothing was paid to Meta). The totals above are exact.
        </p>
      </div>
    </>
  )
}
