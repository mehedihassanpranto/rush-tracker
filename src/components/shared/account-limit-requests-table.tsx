import { Link } from '@tanstack/react-router'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { StatusBadge } from '@/components/shared/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { LimitRequestWithRefs } from '@/types/domain'

function fmt(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export interface AccountLimitRequestRow extends LimitRequestWithRefs {
  organization?: { id: string; name: string } | null
}

/** Every limit request against one ad account, any status, newest first —
 * the account page's Limit Requests tab. `area` picks the detail link; the
 * platform view adds the agency and leaves out the agency's BDT charge to
 * its client. */
export function AccountLimitRequestsTable({
  rows,
  area,
}: {
  rows: Array<AccountLimitRequestRow>
  area: 'agency' | 'platform'
}) {
  const platform = area === 'platform'
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Request</TableHead>
          {platform && <TableHead>Agency</TableHead>}
          <TableHead>Client</TableHead>
          <TableHead>Requested</TableHead>
          <TableHead className="text-right">Opening</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Approved</TableHead>
          <TableHead className="text-right">New limit</TableHead>
          {!platform && <TableHead className="text-right">Charge</TableHead>}
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={9}>
              <div className="py-8 text-center text-sm text-muted-foreground">
                No limit requests yet.
              </div>
            </TableCell>
          </TableRow>
        )}
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-mono text-xs">
              {platform ? (
                <Link
                  to="/platform/limit-requests/$requestId"
                  params={{ requestId: r.id }}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {r.request_number}
                </Link>
              ) : (
                <Link
                  to="/agency/limit-requests/$requestId"
                  params={{ requestId: r.id }}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {r.request_number}
                </Link>
              )}
            </TableCell>
            {platform && <TableCell>{r.organization?.name ?? '—'}</TableCell>}
            <TableCell>{r.client?.name ?? '—'}</TableCell>
            <TableCell className="whitespace-nowrap">{fmt(r.requested_at)}</TableCell>
            <TableCell className="num text-right">{formatUsd(r.opening_balance_usd)}</TableCell>
            <TableCell className="num text-right">{formatUsd(r.requested_amount_usd)}</TableCell>
            <TableCell className="num text-right font-medium">
              {r.approved_amount_usd ? formatUsd(r.approved_amount_usd) : '—'}
            </TableCell>
            <TableCell className="num text-right">
              {r.approved_new_limit_usd ? formatUsd(r.approved_new_limit_usd) : '—'}
            </TableCell>
            {!platform && (
              <TableCell className="num text-right">
                {r.bdt_charge ? formatBdt(r.bdt_charge) : '—'}
              </TableCell>
            )}
            <TableCell>
              <StatusBadge status={r.status} />
              {r.approved_at && (
                <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                  {fmt(r.approved_at)}
                </p>
              )}
              {r.status === 'REJECTED' && r.rejection_reason && (
                <p className="mt-1 max-w-48 text-xs text-muted-foreground">{r.rejection_reason}</p>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
