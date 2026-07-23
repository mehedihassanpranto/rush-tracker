import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { HandCoins } from 'lucide-react'

import { listMyPaymentRequestsFn } from '@/server/payment-requests/payment-request.fns'
import { getMyDueFn } from '@/server/payments/payment.fns'
import { formatBdt } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { PayDialog } from '@/components/client/pay-dialog'
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
import type { PaymentRequest } from '@/types/domain'

export const Route = createFileRoute('/portal/payment-requests/')({
  component: MyPaymentRequestsPage,
})

function fmtDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const OPEN_STATUSES = ['REQUESTED', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID']

function MyPaymentRequestsPage() {
  const listRequests = useServerFn(listMyPaymentRequestsFn)
  const getDue = useServerFn(getMyDueFn)
  const [payFor, setPayFor] = useState<PaymentRequest | null>(null)

  const { data: requests, isLoading } = useQuery({
    queryKey: ['my-payment-requests'],
    queryFn: () => listRequests(),
  })
  const { data: due } = useQuery({
    queryKey: ['my-due'],
    queryFn: () => getDue(),
  })

  return (
    <div>
      <PageHeader
        title="Payment Requests"
        description="Payment requests sent to you by the team."
      />

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Due date</TableHead>
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

            {!isLoading && (requests?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <HandCoins className="size-8 opacity-40" />
                    No payment requests.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {requests?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  {r.request_number}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatBdt(r.requested_amount_bdt)}
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {r.message ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {fmtDate(r.due_date)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-right">
                  {OPEN_STATUSES.includes(r.status) && (
                    <Button size="sm" onClick={() => setPayFor(r)}>
                      Pay now
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <PayDialog
        open={payFor !== null}
        onOpenChange={(o) => !o && setPayFor(null)}
        outstanding={due?.outstanding ?? '0'}
        presetAmount={payFor?.requested_amount_bdt}
        paymentRequestId={payFor?.id}
      />
    </div>
  )
}
