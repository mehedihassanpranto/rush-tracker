import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { HandCoins, Plus } from 'lucide-react'
import { toast } from 'sonner'

import {
  cancelPaymentRequestFn,
  listPaymentRequestsFn,
} from '@/server/payment-requests/payment-request.fns'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { formatBdt } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { RequestPaymentDialog } from '@/components/admin/payment/request-payment-dialog'
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

export const Route = createFileRoute('/admin/payment-requests/')({
  component: PaymentRequestsPage,
})

function fmtDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const CANCELLABLE = ['REQUESTED', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID']

function PaymentRequestsPage() {
  const { user } = Route.useRouteContext()
  const canCreate = hasPermission(user, PERMISSIONS.PAYMENT_REQUESTS_CREATE)
  const queryClient = useQueryClient()
  const listRequests = useServerFn(listPaymentRequestsFn)
  const cancelRequest = useServerFn(cancelPaymentRequestFn)
  const [createOpen, setCreateOpen] = useState(false)

  const { data: requests, isLoading } = useQuery({
    queryKey: ['payment-requests', 'all'],
    queryFn: () => listRequests({ data: {} }),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelRequest({ data: { id } }),
    onSuccess: () => {
      toast.success('Request cancelled')
      void queryClient.invalidateQueries({ queryKey: ['payment-requests'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <div>
      <PageHeader
        title="Payment Requests"
        description="Requests asking clients to pay their due."
      >
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New request
          </Button>
        )}
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Due date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (requests?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <HandCoins className="size-8 opacity-40" />
                    No payment requests yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {requests?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  {r.request_number}
                </TableCell>
                <TableCell>
                  {r.client ? (
                    <Link
                      to="/admin/clients/$clientId"
                      params={{ clientId: r.client.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {r.client.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatBdt(r.requested_amount_bdt)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {fmtDate(r.due_date)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-right">
                  {canCreate && CANCELLABLE.includes(r.status) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancelMutation.isPending}
                      onClick={() => cancelMutation.mutate(r.id)}
                    >
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <RequestPaymentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
