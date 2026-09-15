import { useEffect, useRef, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { AlertTriangle, ArrowLeft, CheckCircle2, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  approvePlatformLimitRequestFn,
  getPlatformLimitProofUrlFn,
  getPlatformLimitRequestFn,
  rebasePlatformLimitRequestFn,
  rejectPlatformLimitRequestFn,
} from '@/server/platform/limit-requests.fns'
import { addUsd, formatBdt, formatUsd, multiplyUsdByRate } from '@/lib/money/money'
import { ProofViewerDialog } from '@/components/shared/proof-viewer'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/platform/limit-requests/$requestId')({
  component: PlatformApprovalPage,
})

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function PlatformApprovalPage() {
  const { requestId } = Route.useParams()
  const queryClient = useQueryClient()

  const getDetail = useServerFn(getPlatformLimitRequestFn)
  const getProofUrl = useServerFn(getPlatformLimitProofUrlFn)
  const approve = useServerFn(approvePlatformLimitRequestFn)
  const reject = useServerFn(rejectPlatformLimitRequestFn)
  const rebase = useServerFn(rebasePlatformLimitRequestFn)

  const [amount, setAmount] = useState('')
  const [rate, setRate] = useState('')
  const [note, setNote] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [proofOpen, setProofOpen] = useState(false)

  const { data: detail, isLoading } = useQuery({
    queryKey: ['platform-limit-request', requestId],
    queryFn: () => getDetail({ data: { id: requestId } }),
  })

  const seeded = useRef(false)
  useEffect(() => {
    if (detail && !seeded.current) {
      setAmount(detail.requested_amount_usd)
      if (detail.applicable_usd_rate && Number(detail.applicable_usd_rate) > 0) {
        setRate(detail.applicable_usd_rate)
      }
      seeded.current = true
    }
  }, [detail])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform-limit-request', requestId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-limit-requests'] })
  }

  const approveMutation = useMutation({
    mutationFn: () =>
      approve({
        data: {
          id: requestId,
          approved_amount_usd: Number(amount),
          approved_usd_rate: Number(rate),
          admin_note: note || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Limit request approved')
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Approval failed'),
  })

  const rejectMutation = useMutation({
    mutationFn: () => reject({ data: { id: requestId, rejection_reason: reason } }),
    onSuccess: () => {
      toast.success('Request rejected')
      setRejectOpen(false)
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const rebaseMutation = useMutation({
    mutationFn: () => rebase({ data: { id: requestId } }),
    onSuccess: () => {
      toast.success('Baseline refreshed')
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  if (isLoading || !detail) {
    return <Skeleton className="h-96 w-full" />
  }

  const isActionable = detail.status === 'PENDING_PLATFORM_REVIEW'
  const amountNum = Number(amount)
  const rateNum = Number(rate)
  const amountValid = amount !== '' && Number.isFinite(amountNum) && amountNum > 0
  const rateValid = rate !== '' && Number.isFinite(rateNum) && rateNum > 0

  const newLimit =
    amountValid && detail.account_current_limit_usd
      ? addUsd(detail.opening_balance_usd, amountNum).toString()
      : null
  const charge =
    amountValid && rateValid ? multiplyUsdByRate(amountNum, rateNum).toString() : null

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        to="/platform/limit-requests"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Limit Requests
      </Link>

      <PageHeader title={detail.request_number}>
        <StatusBadge status={detail.status} />
      </PageHeader>

      <div className="grid gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Request</CardTitle>
          </CardHeader>
          <CardContent>
            <Row
              label="Agency"
              value={
                detail.organization ? (
                  <Link
                    to="/platform/organizations/$organizationId"
                    params={{ organizationId: detail.organization.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {detail.organization.name}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Row label="Client" value={detail.client?.name ?? '—'} />
            <Row
              label="Ad account"
              value={
                detail.ad_account ? (
                  <Link
                    to="/platform/ad-accounts/$accountId"
                    params={{ accountId: detail.ad_account.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {detail.ad_account.name} ({detail.ad_account.account_code})
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Row
              label="Opening balance"
              value={formatUsd(detail.opening_balance_usd)}
            />
            <Row
              label="Requested amount"
              value={formatUsd(detail.requested_amount_usd)}
            />
            <Row label="Rate at request" value={`৳${detail.default_usd_rate}`} />
            <Row label="Total cost" value={formatBdt(detail.total_cost_bdt)} />
            {detail.segment !== 'postpaid' && (
              <Row label="Amount paid" value={formatBdt(detail.amount_paid_bdt)} />
            )}
            <Row
              label="Sent to platform"
              value={
                detail.sent_to_platform_at
                  ? new Date(detail.sent_to_platform_at).toLocaleString()
                  : '—'
              }
            />
          </CardContent>
        </Card>

        {detail.is_stale && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>The account limit changed since this request</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <span>
                Request opening balance is{' '}
                {formatUsd(detail.opening_balance_usd)}, but the account current
                limit is now{' '}
                {formatUsd(detail.account_current_limit_usd ?? '0')}. Refresh the
                baseline before approving.
              </span>
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={rebaseMutation.isPending}
                onClick={() => rebaseMutation.mutate()}
              >
                {rebaseMutation.isPending && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                Rebase to {formatUsd(detail.account_current_limit_usd ?? '0')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {isActionable ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Approval</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Approved amount (USD)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>USD rate (BDT)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/40 p-3 text-sm">
                <div>
                  <div className="text-muted-foreground">New current limit</div>
                  <div className="font-medium">
                    {newLimit ? formatUsd(newLimit) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Client charge</div>
                  <div className="font-medium">
                    {charge ? formatBdt(charge) : '—'}
                  </div>
                </div>
              </div>

              {detail.has_proof && (
                <div className="space-y-2">
                  <Label>Limit update proof</Label>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1 text-sm text-emerald-600">
                      <CheckCircle2 className="size-4" />
                      Proof attached
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setProofOpen(true)}
                    >
                      <FileText className="size-4" />
                      View
                    </Button>
                  </div>
                </div>
              )}

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
                  disabled={
                    !amountValid ||
                    !rateValid ||
                    detail.is_stale ||
                    approveMutation.isPending
                  }
                  onClick={() => approveMutation.mutate()}
                >
                  {approveMutation.isPending && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Approve
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : detail.status === 'PENDING' ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Not Yet Sent</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                This request is still with {detail.organization?.name ?? 'the agency'}
                {' '}— it hasn't been sent here for review yet.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Outcome</CardTitle>
            </CardHeader>
            <CardContent>
              {detail.status === 'APPROVED' && (
                <>
                  <Row
                    label="Approved amount"
                    value={formatUsd(detail.approved_amount_usd ?? '0')}
                  />
                  <Row label="Applied rate" value={`৳${detail.approved_usd_rate}`} />
                  <Row
                    label="New current limit"
                    value={formatUsd(detail.approved_new_limit_usd ?? '0')}
                  />
                  <Row
                    label="Client charge"
                    value={formatBdt(detail.bdt_charge ?? '0')}
                  />
                  {detail.admin_note && <Row label="Note" value={detail.admin_note} />}
                </>
              )}
              {detail.status === 'REJECTED' && (
                <Row label="Reason" value={detail.rejection_reason ?? '—'} />
              )}
              {detail.status === 'CANCELLED' && (
                <p className="text-sm text-muted-foreground">
                  This request was cancelled by the client.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject request</DialogTitle>
            <DialogDescription>
              The client will see this reason. Nothing is billed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
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
              {rejectMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProofViewerDialog
        open={proofOpen}
        onOpenChange={setProofOpen}
        fetchUrl={() => getProofUrl({ data: { id: requestId } })}
        title="Limit update proof"
      />
    </div>
  )
}
