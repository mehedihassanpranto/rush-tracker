import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Inbox } from 'lucide-react'

import { listPlatformAccountRequestsFn } from '@/server/platform/account-requests.fns'
import type { PlatformAccountRequestRow } from '@/server/platform/account-requests.fns'
import {
  AssignRequestDialog,
  RejectRequestDialog,
} from '@/components/platform/account-requests/request-dialogs'
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

type Filter = 'PENDING' | 'FULFILLED' | 'REJECTED' | 'CANCELLED' | 'ALL'

const FILTERS: Array<Filter> = ['PENDING', 'FULFILLED', 'REJECTED', 'CANCELLED', 'ALL']

const FILTER_LABELS: Record<Filter, string> = {
  PENDING: 'Pending',
  FULFILLED: 'Assigned',
  REJECTED: 'Declined',
  CANCELLED: 'Withdrawn',
  ALL: 'All',
}

/**
 * Agencies asking the platform for a NEW ad account (spec §4.4 / §5 item 4).
 * Not to be confused with Limit Requests, which are a client asking to raise
 * the cap on an account that already exists.
 */
export const Route = createFileRoute('/platform/account-requests/')({
  component: PlatformAccountRequestsPage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function PlatformAccountRequestsPage() {
  const listRequests = useServerFn(listPlatformAccountRequestsFn)
  const [filter, setFilter] = useState<Filter>('PENDING')
  const [assigning, setAssigning] = useState<PlatformAccountRequestRow | null>(null)
  const [rejecting, setRejecting] = useState<PlatformAccountRequestRow | null>(null)

  const { data: requests, isLoading, error } = useQuery({
    queryKey: ['platform-account-requests', filter],
    queryFn: () => listRequests({ data: { status: filter } }),
  })

  return (
    <div>
      <PageHeader
        title="Account Requests"
        description="Agencies asking for a new ad account from the pool."
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
              <TableHead>Notes</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {error && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="py-10 text-center text-sm text-destructive">
                    Couldn't load requests:{' '}
                    {error instanceof Error ? error.message : 'unknown error'}
                  </div>
                </TableCell>
              </TableRow>
            )}

            {!isLoading && !error && (requests?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Inbox className="size-8 opacity-40" />
                    No {filter === 'ALL' ? '' : FILTER_LABELS[filter].toLowerCase() + ' '}
                    requests.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {requests?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.request_number}</TableCell>
                <TableCell>
                  {r.organization ? (
                    <Link
                      to="/platform/organizations/$organizationId"
                      params={{ organizationId: r.organization.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {r.organization.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="max-w-md whitespace-normal text-sm text-muted-foreground">
                  {r.notes}
                  {r.status === 'FULFILLED' && r.fulfilled_ad_account && (
                    <div className="mt-1 text-foreground">
                      Assigned{' '}
                      <Link
                        to="/platform/ad-accounts/$accountId"
                        params={{ accountId: r.fulfilled_ad_account.id }}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {r.fulfilled_ad_account.account_code} —{' '}
                        {r.fulfilled_ad_account.name}
                      </Link>
                    </div>
                  )}
                  {r.status === 'REJECTED' && r.decision_reason && (
                    <div className="mt-1 text-destructive">
                      Declined: {r.decision_reason}
                    </div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(r.created_at)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-right">
                  {r.status === 'PENDING' && (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => setAssigning(r)}>
                        Assign account
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRejecting(r)}
                      >
                        Decline
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <AssignRequestDialog
        request={assigning}
        onOpenChange={(open) => !open && setAssigning(null)}
      />
      <RejectRequestDialog
        request={rejecting}
        onOpenChange={(open) => !open && setRejecting(null)}
      />
    </div>
  )
}
