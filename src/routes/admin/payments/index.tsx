import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Wallet } from 'lucide-react'

import { listPaymentsFn } from '@/server/payments/payment.fns'
import { formatBdt } from '@/lib/money/money'
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
const FILTERS: Array<Filter> = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL']

export const Route = createFileRoute('/admin/payments/')({
  component: PaymentsPage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function PaymentsPage() {
  const listPayments = useServerFn(listPaymentsFn)
  const [filter, setFilter] = useState<Filter>('PENDING')

  const { data: payments, isLoading } = useQuery({
    queryKey: ['payments', filter],
    queryFn: () => listPayments({ data: { status: filter } }),
  })

  return (
    <div>
      <PageHeader
        title="Payments"
        description="Review and verify client payments."
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
              <TableHead>Payment</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
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

            {!isLoading && (payments?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Wallet className="size-8 opacity-40" />
                    No {filter === 'ALL' ? '' : filter.toLowerCase()} payments.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {payments?.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">
                  <Link
                    to="/admin/payments/$paymentId"
                    params={{ paymentId: p.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {p.payment_number}
                  </Link>
                </TableCell>
                <TableCell>{p.client?.name ?? '—'}</TableCell>
                <TableCell className="text-right font-medium">
                  {formatBdt(p.amount_bdt)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {p.payment_method ?? '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={p.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(p.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
