import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Gauge } from 'lucide-react'

import { listLimitRequestsFn } from '@/server/limit-requests/limit-request.fns'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
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

type Filter = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'ALL'

const FILTERS: Array<Filter> = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'ALL',
]

export const Route = createFileRoute('/admin/limit-requests/')({
  component: LimitRequestsPage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function LimitRequestsPage() {
  const listRequests = useServerFn(listLimitRequestsFn)
  const [filter, setFilter] = useState<Filter>('PENDING')

  const { data: requests, isLoading } = useQuery({
    queryKey: ['limit-requests', filter],
    queryFn: () => listRequests({ data: { status: filter } }),
  })

  return (
    <div>
      <PageHeader
        title="Limit Requests"
        description="Review and approve client limit increase requests."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? 'default' : 'outline'}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0) + f.slice(1).toLowerCase()}
          </Button>
        ))}
      </div>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Requested</TableHead>
              <TableHead className="text-right">Approved</TableHead>
              <TableHead className="text-right">Charge</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (requests?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={9}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Gauge className="size-8 opacity-40" />
                    No {filter === 'ALL' ? '' : filter.toLowerCase()} requests.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {requests?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  <Link
                    to="/admin/limit-requests/$requestId"
                    params={{ requestId: r.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {r.request_number}
                  </Link>
                </TableCell>
                <TableCell>{r.client?.name ?? '—'}</TableCell>
                <TableCell>{r.ad_account?.name ?? '—'}</TableCell>
                <TableCell className="text-right">
                  {formatUsd(r.opening_balance_usd)}
                </TableCell>
                <TableCell className="text-right">
                  {formatUsd(r.requested_amount_usd)}
                </TableCell>
                <TableCell className="text-right">
                  {r.approved_amount_usd ? formatUsd(r.approved_amount_usd) : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {r.bdt_charge ? formatBdt(r.bdt_charge) : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(r.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
