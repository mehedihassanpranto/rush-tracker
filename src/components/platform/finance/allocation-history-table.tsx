import { Landmark } from 'lucide-react'

import { formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime, fmtRate } from '@/components/platform/finance/format'
import type { AllocationHistoryRow } from '@/lib/finance/agency-allocations'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AgencyLimitApproval, UsdSaleWithRefs } from '@/types/domain'

/** A recorded sale, as one row of an agency's allocation history. */
export function saleToHistoryRow(s: UsdSaleWithRefs): AllocationHistoryRow {
  return {
    kind: 'SALE',
    id: s.id,
    reference: s.reference_id,
    at: s.sold_at,
    usd_amount: s.usd_amount,
    bdt_amount: s.bdt_amount,
    rate: s.selling_rate,
    ad_account: s.ad_account,
  }
}

/** An approved limit request, as one row of the same history. It has no BDT
 * and no rate: neither is recorded against a limit approval. Approved requests
 * always carry an approval time; one without is skipped by the caller. */
export function limitToHistoryRow(l: AgencyLimitApproval & { approved_at: string }): AllocationHistoryRow {
  return {
    kind: 'LIMIT',
    id: l.id,
    reference: l.request_number,
    at: l.approved_at,
    usd_amount: l.approved_amount_usd,
    bdt_amount: null,
    rate: null,
    ad_account: l.ad_account,
  }
}

/**
 * Everything the platform has allocated to one agency, newest first: the sales
 * recorded by hand, and the approved limit requests on platform-owned accounts.
 * The Type column keeps the two distinguishable — they can overlap, so the
 * reader needs to see which is which.
 */
export function AllocationHistoryTable({
  rows,
  isLoading,
  error,
  emptyText,
}: {
  rows: Array<AllocationHistoryRow> | undefined
  isLoading: boolean
  error?: unknown
  emptyText: string
}) {
  const cols = 7
  return (
    <Card className="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Ad account</TableHead>
            <TableHead className="text-right">USD</TableHead>
            <TableHead className="text-right">BDT received</TableHead>
            <TableHead className="text-right">Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading &&
            Array.from({ length: 3 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell colSpan={cols}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ))}

          {!!error && (
            <TableRow>
              <TableCell colSpan={cols}>
                <div className="py-10 text-center text-sm text-destructive">
                  Couldn't load the history:{' '}
                  {error instanceof Error ? error.message : 'unknown error'}
                </div>
              </TableCell>
            </TableRow>
          )}

          {!isLoading && !error && (rows?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={cols}>
                <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                  <Landmark className="size-8 opacity-40" />
                  {emptyText}
                </div>
              </TableCell>
            </TableRow>
          )}

          {rows?.map((r) => (
            <TableRow key={`${r.kind}-${r.id}`}>
              <TableCell>
                <Badge variant={r.kind === 'SALE' ? 'outline' : 'secondary'}>
                  {r.kind === 'SALE' ? 'Sale' : 'Limit approval'}
                </Badge>
              </TableCell>
              <TableCell className="num whitespace-nowrap text-xs">{r.reference}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {fmtDateTime(r.at)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {r.ad_account ? `${r.ad_account.account_code} — ${r.ad_account.name}` : '—'}
              </TableCell>
              <TableCell className="num text-right">{formatUsd(r.usd_amount)}</TableCell>
              <TableCell className="num text-right">
                {r.bdt_amount === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  formatBdt(r.bdt_amount)
                )}
              </TableCell>
              <TableCell className="num text-right text-muted-foreground">
                {r.rate === null ? '—' : fmtRate(r.rate)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}
