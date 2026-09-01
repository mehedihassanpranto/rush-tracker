import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Wallet } from 'lucide-react'

import { listPaymentsFn } from '@/server/payments/payment.fns'
import { formatBdt } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { railClassName, type RailHealth } from '@/components/shared/status-rail'
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

// Payment health for the status rail: APPROVED is settled (on-track),
// PENDING is awaiting review (near-cap), REJECTED/CANCELLED never landed
// (over-cap) — a payment-side reading of the same three-tier signal the ad
// account/client rails use for budget headroom.
function paymentHealth(status: string): RailHealth {
  if (status === 'APPROVED') return 'on-track'
  if (status === 'PENDING') return 'near-cap'
  return 'over-cap'
}

function fmtDateTime(value: string): string {
  const d = new Date(value)
  const datePart = d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  let hours = d.getHours()
  const ampm = hours >= 12 ? 'pm' : 'am'
  hours = hours % 12 || 12
  const hh = String(hours).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${datePart}, ${hh}:${mm} ${ampm}`
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
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (payments?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Wallet className="size-8 opacity-40" />
                    No {filter === 'ALL' ? '' : filter.toLowerCase()} payments.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {payments?.map((p) => (
              <TableRow key={p.id} className={railClassName(paymentHealth(p.status))}>
                <TableCell className="num text-xs">
                  <Link
                    to="/admin/payments/$paymentId"
                    params={{ paymentId: p.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {p.payment_number}
                  </Link>
                </TableCell>
                <TableCell>{p.client?.name ?? '—'}</TableCell>
                <TableCell className="num text-right font-medium">
                  {formatBdt(p.amount_bdt)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {p.payment_method ?? '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={p.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDateTime(p.created_at)}
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {p.admin_note ?? p.rejection_reason ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
