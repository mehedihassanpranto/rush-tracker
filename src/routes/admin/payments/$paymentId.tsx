import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ArrowLeft, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  approvePaymentFn,
  getPaymentDetailFn,
  getPaymentProofUrlFn,
  rejectPaymentFn,
} from '@/server/payments/payment.fns'
import { formatBdt } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/admin/payments/$paymentId')({
  component: PaymentDetailPage,
})

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function PaymentDetailPage() {
  const { paymentId } = Route.useParams()
  const queryClient = useQueryClient()
  const getDetail = useServerFn(getPaymentDetailFn)
  const getProofUrl = useServerFn(getPaymentProofUrlFn)
  const approve = useServerFn(approvePaymentFn)
  const reject = useServerFn(rejectPaymentFn)

  const [note, setNote] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')

  const { data: payment, isLoading } = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => getDetail({ data: { id: paymentId } }),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['payment', paymentId] })
    void queryClient.invalidateQueries({ queryKey: ['payments'] })
    void queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] })
  }

  const approveMutation = useMutation({
    mutationFn: () =>
      approve({ data: { id: paymentId, admin_note: note || undefined } }),
    onSuccess: () => {
      toast.success('Payment approved')
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const rejectMutation = useMutation({
    mutationFn: () =>
      reject({ data: { id: paymentId, rejection_reason: reason } }),
    onSuccess: () => {
      toast.success('Payment rejected')
      setRejectOpen(false)
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  async function viewProof() {
    try {
      const { url } = await getProofUrl({ data: { id: paymentId } })
      if (url) window.open(url, '_blank', 'noopener')
      else toast.info('No proof uploaded')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  if (isLoading || !payment) {
    return <Skeleton className="h-80 w-full" />
  }

  const isPending = payment.status === 'PENDING'

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/admin/payments"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Payments
      </Link>

      <PageHeader title={payment.payment_number}>
        <StatusBadge status={payment.status} />
      </PageHeader>

      <div className="grid gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Payment</CardTitle>
          </CardHeader>
          <CardContent>
            <Row
              label="Client"
              value={
                payment.client ? (
                  <Link
                    to="/admin/clients/$clientId"
                    params={{ clientId: payment.client.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {payment.client.name}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Row label="Amount" value={formatBdt(payment.amount_bdt)} />
            <Row label="Method" value={payment.payment_method ?? '—'} />
            <Row
              label="Reference"
              value={payment.transaction_reference ?? '—'}
            />
            {payment.status === 'REJECTED' && (
              <Row label="Rejection reason" value={payment.rejection_reason ?? '—'} />
            )}
            {payment.admin_note && (
              <Row label="Admin note" value={payment.admin_note} />
            )}
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => void viewProof()}>
                <FileText className="size-4" />
                View proof
              </Button>
            </div>
          </CardContent>
        </Card>

        {isPending && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Verify</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Admin note (optional)</Label>
                <Textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button variant="outline" onClick={() => setRejectOpen(true)}>
                  Reject
                </Button>
                <Button
                  disabled={approveMutation.isPending}
                  onClick={() => approveMutation.mutate()}
                >
                  {approveMutation.isPending && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Approve payment
                </Button>
              </div>
              <p className="text-right text-xs text-muted-foreground">
                Approving credits {formatBdt(payment.amount_bdt)} to the
                client&apos;s ledger.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject payment</DialogTitle>
            <DialogDescription>
              The client will see this reason. No ledger entry is created.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim() || rejectMutation.isPending}
              onClick={() => rejectMutation.mutate()}
            >
              {rejectMutation.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Reject payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
