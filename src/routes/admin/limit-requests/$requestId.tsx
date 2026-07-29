import { useEffect, useRef, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  approveLimitRequestFn,
  getLimitProofUrlFn,
  getLimitRequestDetailFn,
  rebaseLimitRequestFn,
  rejectLimitRequestFn,
  uploadLimitProofFn,
} from '@/server/limit-requests/limit-request.fns'
import { addUsd, formatBdt, formatUsd, multiplyUsdByRate } from '@/lib/money/money'
import { ProofViewerDialog } from '@/components/shared/proof-viewer'
import {
  ALLOWED_PROOF_MIME,
  MAX_PROOF_BYTES,
} from '@/schemas/limit-request'
import { fileToBase64, formatFileSize } from '@/lib/utils/file'
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

export const Route = createFileRoute('/admin/limit-requests/$requestId')({
  component: ApprovalPage,
})

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function ApprovalPage() {
  const { requestId } = Route.useParams()
  const queryClient = useQueryClient()

  const getDetail = useServerFn(getLimitRequestDetailFn)
  const getProofUrl = useServerFn(getLimitProofUrlFn)
  const uploadProof = useServerFn(uploadLimitProofFn)
  const approve = useServerFn(approveLimitRequestFn)
  const reject = useServerFn(rejectLimitRequestFn)
  const rebase = useServerFn(rebaseLimitRequestFn)

  const fileRef = useRef<HTMLInputElement>(null)
  const [amount, setAmount] = useState('')
  const [rate, setRate] = useState('')
  const [note, setNote] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [proofOpen, setProofOpen] = useState(false)

  const { data: detail, isLoading } = useQuery({
    queryKey: ['limit-request', requestId],
    queryFn: () => getDetail({ data: { id: requestId } }),
  })

  // Seed the form once the request loads (approved amount defaults to
  // requested; rate prefills from THIS AD ACCOUNT's configured rate, falling
  // back to the client's when unset — spec §25, §26; the applied rate is still
  // editable and snapshotted per approval).
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
    void queryClient.invalidateQueries({ queryKey: ['limit-request', requestId] })
    void queryClient.invalidateQueries({ queryKey: ['limit-requests'] })
    void queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] })
  }

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const data_base64 = await fileToBase64(file)
      return uploadProof({
        data: {
          request_id: requestId,
          file_name: file.name,
          mime_type: file.type as (typeof ALLOWED_PROOF_MIME)[number],
          data_base64,
        },
      })
    },
    onSuccess: () => {
      toast.success('Proof uploaded')
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Upload failed'),
  })

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

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!ALLOWED_PROOF_MIME.includes(file.type as never)) {
      toast.error('Use JPG, PNG, WEBP or PDF')
      return
    }
    if (file.size > MAX_PROOF_BYTES) {
      toast.error('File must be 3 MB or smaller')
      return
    }
    uploadMutation.mutate(file)
    e.target.value = ''
  }

  function viewProof() {
    setProofOpen(true)
  }

  if (isLoading || !detail) {
    return <Skeleton className="h-96 w-full" />
  }

  const isPending = detail.status === 'PENDING'
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
        to="/admin/limit-requests"
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
              label="Client"
              value={
                detail.client ? (
                  <Link
                    to="/admin/clients/$clientId"
                    params={{ clientId: detail.client.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {detail.client.name}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Row
              label="Ad account"
              value={
                detail.ad_account ? (
                  <Link
                    to="/admin/ad-accounts/$accountId"
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
            <Row
              label="Rate at request"
              value={`৳${detail.default_usd_rate}`}
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

        {isPending ? (
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

              <div className="space-y-2">
                <Label>Limit update proof</Label>
                <div className="flex items-center gap-3">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={onPickFile}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadMutation.isPending}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploadMutation.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Upload className="size-4" />
                    )}
                    {detail.has_proof ? 'Replace proof' : 'Upload proof'}
                  </Button>
                  {detail.has_proof && (
                    <>
                      <span className="flex items-center gap-1 text-sm text-emerald-600">
                        <CheckCircle2 className="size-4" />
                        Proof attached
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void viewProof()}
                      >
                        <FileText className="size-4" />
                        View
                      </Button>
                    </>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  JPG, PNG, WEBP or PDF, up to {formatFileSize(MAX_PROOF_BYTES)}.
                  Required before approval.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Admin note (optional)</Label>
                <Textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  onClick={() => setRejectOpen(true)}
                >
                  Reject
                </Button>
                <Button
                  disabled={
                    !amountValid ||
                    !rateValid ||
                    !detail.has_proof ||
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
              {!detail.has_proof && (
                <p className="text-right text-xs text-muted-foreground">
                  Upload proof to enable approval.
                </p>
              )}
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
                  <Row
                    label="Applied rate"
                    value={`৳${detail.approved_usd_rate}`}
                  />
                  <Row
                    label="New current limit"
                    value={formatUsd(detail.approved_new_limit_usd ?? '0')}
                  />
                  <Row
                    label="Client charge"
                    value={formatBdt(detail.bdt_charge ?? '0')}
                  />
                  {detail.admin_note && (
                    <Row label="Note" value={detail.admin_note} />
                  )}
                  <div className="mt-3">
                    <Button variant="outline" size="sm" onClick={() => void viewProof()}>
                      <FileText className="size-4" />
                      View proof
                    </Button>
                  </div>
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
