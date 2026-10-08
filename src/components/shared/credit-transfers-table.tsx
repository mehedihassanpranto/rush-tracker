import { formatUsd } from '@/lib/money/money'
import { StatusBadge } from '@/components/shared/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { CreditTransferRow } from '@/types/domain'

function fmt(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Credit transfers (Move credit) list — used on an ad account's page and
 * the platform's review page. `actions` renders per-row buttons. */
export function CreditTransfersTable({
  rows,
  showAgency = false,
  actions,
}: {
  rows: Array<CreditTransferRow>
  showAgency?: boolean
  actions?: (row: CreditTransferRow) => React.ReactNode
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Number</TableHead>
          {showAgency && <TableHead>Agency</TableHead>}
          <TableHead>Client</TableHead>
          <TableHead>From</TableHead>
          <TableHead>To</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Requested</TableHead>
          <TableHead>Status</TableHead>
          {actions && <TableHead className="text-right" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={showAgency ? 9 : 8}>
              <div className="py-8 text-center text-sm text-muted-foreground">
                No credit moves yet.
              </div>
            </TableCell>
          </TableRow>
        )}
        {rows.map((t) => (
          <TableRow key={t.id}>
            <TableCell className="num text-xs">{t.transfer_number}</TableCell>
            {showAgency && <TableCell>{t.organization?.name ?? '—'}</TableCell>}
            <TableCell>{t.client?.name ?? '—'}</TableCell>
            <TableCell className="num text-xs">{t.source?.account_code ?? '—'}</TableCell>
            <TableCell className="num text-xs">{t.destination?.account_code ?? '—'}</TableCell>
            <TableCell className="num text-right font-medium">
              {formatUsd(String(t.amount_usd))}
            </TableCell>
            <TableCell>{fmt(t.requested_at)}</TableCell>
            <TableCell>
              <StatusBadge status={t.status} />
              {t.status === 'REJECTED' && t.rejection_reason && (
                <p className="mt-1 max-w-48 text-xs text-muted-foreground">{t.rejection_reason}</p>
              )}
            </TableCell>
            {actions && <TableCell className="text-right">{actions(t)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
