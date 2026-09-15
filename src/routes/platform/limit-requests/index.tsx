import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Gauge } from 'lucide-react'

import { listPlatformLimitRequestsFn } from '@/server/platform/limit-requests.fns'
import { formatUsd } from '@/lib/money/money'
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

type Filter =
  | 'PENDING'
  | 'PENDING_PLATFORM_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'ALL'

const FILTERS: Array<Filter> = [
  'PENDING_PLATFORM_REVIEW',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'ALL',
]

const FILTER_LABELS: Record<Filter, string> = {
  PENDING: 'Not Yet Sent',
  PENDING_PLATFORM_REVIEW: 'Awaiting Review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  ALL: 'All',
}

/**
 * Limit requests on platform-assigned accounts, across every agency — the
 * escalation queue §4.3 of the "Mother Platform Account Control" spec asked
 * for. Defaults to the actionable "Awaiting Review" tab; the others are
 * visibility only (a request not yet sent up, or one already resolved).
 */
export const Route = createFileRoute('/platform/limit-requests/')({
  component: PlatformLimitRequestsPage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function PlatformLimitRequestsPage() {
  const listRequests = useServerFn(listPlatformLimitRequestsFn)
  const [filter, setFilter] = useState<Filter>('PENDING_PLATFORM_REVIEW')

  const { data: requests, isLoading } = useQuery({
    queryKey: ['platform-limit-requests', filter],
    queryFn: () => listRequests({ data: { status: filter } }),
  })

  return (
    <div>
      <PageHeader
        title="Limit Requests"
        description="Requests against platform-assigned accounts, escalated here by an agency for approval."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? 'default' : 'outline'}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABELS[f]}
          </Button>
        ))}
      </div>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request</TableHead>
              <TableHead>Agency</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Requested</TableHead>
              <TableHead className="text-right">Approved</TableHead>
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
                    No {filter === 'ALL' ? '' : FILTER_LABELS[filter].toLowerCase() + ' '}
                    requests.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {requests?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  <Link
                    to="/platform/limit-requests/$requestId"
                    params={{ requestId: r.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {r.request_number}
                  </Link>
                </TableCell>
                <TableCell>{r.organization?.name ?? '—'}</TableCell>
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
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(r.sent_to_platform_at ?? r.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
