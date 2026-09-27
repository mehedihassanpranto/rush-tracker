import { Link } from '@tanstack/react-router'
import { Landmark } from 'lucide-react'

import { formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime, fmtRate } from '@/components/platform/finance/format'
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
import type { UsdSaleWithRefs } from '@/types/domain'

/** Platform USD sales, newest first. Used for the overview's recent sales and
 * for one agency's full history (where the Agency column is redundant). */
export function SalesTable({
  sales,
  isLoading,
  error,
  showAgency = true,
  emptyText = 'No sales recorded yet.',
}: {
  sales: Array<UsdSaleWithRefs> | undefined
  isLoading: boolean
  error?: unknown
  showAgency?: boolean
  emptyText?: string
}) {
  const cols = showAgency ? 7 : 6
  return (
    <Card className="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reference</TableHead>
            <TableHead>Sold</TableHead>
            {showAgency && <TableHead>Agency</TableHead>}
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
                  Couldn't load sales: {error instanceof Error ? error.message : 'unknown error'}
                </div>
              </TableCell>
            </TableRow>
          )}

          {!isLoading && !error && (sales?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={cols}>
                <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                  <Landmark className="size-8 opacity-40" />
                  {emptyText}
                </div>
              </TableCell>
            </TableRow>
          )}

          {sales?.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="num whitespace-nowrap text-xs">{s.reference_id}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {fmtDateTime(s.sold_at)}
              </TableCell>
              {showAgency && (
                <TableCell>
                  {s.organization ? (
                    <Link
                      to="/platform/organizations/$organizationId"
                      params={{ organizationId: s.organization.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {s.organization.name}
                    </Link>
                  ) : (
                    // The agency was deleted; the sale survives with the name
                    // it had at the time.
                    <span className="text-muted-foreground">{s.agency_name} (removed)</span>
                  )}
                </TableCell>
              )}
              <TableCell className="text-muted-foreground">
                {s.ad_account ? `${s.ad_account.account_code} — ${s.ad_account.name}` : '—'}
              </TableCell>
              <TableCell className="num text-right">{formatUsd(s.usd_amount)}</TableCell>
              <TableCell className="num text-right">{formatBdt(s.bdt_amount)}</TableCell>
              <TableCell className="num text-right text-muted-foreground">
                {fmtRate(s.selling_rate)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}
