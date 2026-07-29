import { RotateCcw } from 'lucide-react'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { StatusBadge } from '@/components/shared/status-badge'
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
import type { LedgerEntryWithBalance } from '@/types/domain'

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Ledger table with running balance (spec §36, §37). Optionally shows a
 * per-row reverse action for admins with adjustments.create.
 */
export function LedgerTable({
  entries,
  showBalance = true,
  showUsdAmount = false,
  onReverse,
}: {
  entries: Array<LedgerEntryWithBalance>
  showBalance?: boolean
  /** Show the originating USD amount (approved limit request / payment). */
  showUsdAmount?: boolean
  onReverse?: (entry: LedgerEntryWithBalance) => void
}) {
  const cols =
    6 + (showUsdAmount ? 1 : 0) + (showBalance ? 1 : 0) + (onReverse ? 1 : 0)
  return (
    <Card className="p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Transaction</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
            {showUsdAmount && (
              <TableHead className="text-right">Amount (USD)</TableHead>
            )}
            {showBalance && <TableHead className="text-right">Balance</TableHead>}
            <TableHead>Date</TableHead>
            {onReverse && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 && (
            <TableRow>
              <TableCell colSpan={cols}>
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No transactions yet.
                </div>
              </TableCell>
            </TableRow>
          )}
          {entries.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="font-mono text-xs">
                {e.transaction_number}
              </TableCell>
              <TableCell>
                <StatusBadge status={e.type} />
              </TableCell>
              <TableCell className="max-w-xs truncate text-muted-foreground">
                {e.description ?? '—'}
              </TableCell>
              <TableCell className="text-right">
                {Number(e.debit_bdt) > 0 ? formatBdt(e.debit_bdt) : '—'}
              </TableCell>
              <TableCell className="text-right">
                {Number(e.credit_bdt) > 0 ? formatBdt(e.credit_bdt) : '—'}
              </TableCell>
              {showUsdAmount && (
                <TableCell className="text-right">
                  {e.usd_amount !== null && Number(e.usd_amount) > 0
                    ? formatUsd(e.usd_amount)
                    : '—'}
                </TableCell>
              )}
              {showBalance && (
                <TableCell className="text-right font-medium">
                  {formatBdt(e.balance_after)}
                </TableCell>
              )}
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {fmtDate(e.created_at)}
              </TableCell>
              {onReverse && (
                <TableCell className="text-right">
                  {e.type !== 'REVERSAL' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onReverse(e)}
                    >
                      <RotateCcw className="size-4" />
                      Reverse
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}
