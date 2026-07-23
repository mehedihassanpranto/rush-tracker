import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { FileText, Wallet } from 'lucide-react'
import { toast } from 'sonner'

import {
  cancelMyPaymentFn,
  getMyDueFn,
  getMyPaymentProofUrlFn,
  listMyPaymentsFn,
} from '@/server/payments/payment.fns'
import { formatBdt } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { PayDialog } from '@/components/client/pay-dialog'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const Route = createFileRoute('/portal/due/')({
  component: DuePage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function DuePage() {
  const queryClient = useQueryClient()
  const getDue = useServerFn(getMyDueFn)
  const listPayments = useServerFn(listMyPaymentsFn)
  const getProofUrl = useServerFn(getMyPaymentProofUrlFn)
  const cancelPayment = useServerFn(cancelMyPaymentFn)
  const [payOpen, setPayOpen] = useState(false)

  const { data: due, isLoading } = useQuery({
    queryKey: ['my-due'],
    queryFn: () => getDue(),
  })
  const { data: payments } = useQuery({
    queryKey: ['my-payments'],
    queryFn: () => listPayments(),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelPayment({ data: { id } }),
    onSuccess: () => {
      toast.success('Payment cancelled')
      void queryClient.invalidateQueries({ queryKey: ['my-due'] })
      void queryClient.invalidateQueries({ queryKey: ['my-payments'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  async function viewProof(id: string) {
    try {
      const { url } = await getProofUrl({ data: { id } })
      if (url) window.open(url, '_blank', 'noopener')
      else toast.info('No proof available')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const canPay = due && Number(due.outstanding) > 0

  return (
    <div>
      <PageHeader
        title="Due & Payments"
        description="Pay your outstanding due and track your payments."
      >
        <Button disabled={!canPay} onClick={() => setPayOpen(true)}>
          <Wallet className="size-4" />
          Pay due
        </Button>
      </PageHeader>

      {isLoading || !due ? (
        <Skeleton className="mb-6 h-24 w-full" />
      ) : (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="py-4">
              <CardDescription>Current Due</CardDescription>
              <div className="mt-1 text-2xl font-semibold">
                {formatBdt(due.current_due)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <CardDescription>Pending (awaiting review)</CardDescription>
              <div className="mt-1 text-2xl font-semibold">
                {formatBdt(due.pending_total)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <CardDescription>You can still pay</CardDescription>
              <div className="mt-1 text-2xl font-semibold">
                {formatBdt(due.outstanding)}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Payment history
      </h2>
      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Payment</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(payments?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    No payments yet.
                  </div>
                </TableCell>
              </TableRow>
            )}
            {payments?.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">
                  {p.payment_number}
                </TableCell>
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
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void viewProof(p.id)}
                    >
                      <FileText className="size-4" />
                      Proof
                    </Button>
                    {p.status === 'PENDING' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancelMutation.isPending}
                        onClick={() => cancelMutation.mutate(p.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <PayDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        outstanding={due?.outstanding ?? '0'}
      />
    </div>
  )
}
