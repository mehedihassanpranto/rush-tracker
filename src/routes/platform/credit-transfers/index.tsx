import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  approvePlatformCreditTransferFn,
  listPlatformCreditTransfersFn,
  previewPlatformCreditTransferFn,
  rejectPlatformCreditTransferFn,
} from '@/server/platform/credit-transfers.fns'
import { dec, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { CreditTransfersTable } from '@/components/shared/credit-transfers-table'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import type { CreditTransferRow } from '@/types/domain'

/**
 * Credit moves (credit transfers, migration 000058) that involve a platform
 * pool account wait here for the platform to approve — approving executes the
 * move after a fresh Meta read. Guarded by the /platform layout; the real
 * boundary is requirePlatformAdmin() on every fn.
 */
export const Route = createFileRoute('/platform/credit-transfers/')({
  component: PlatformCreditTransfersPage,
})

function PlatformCreditTransfersPage() {
  const list = useServerFn(listPlatformCreditTransfersFn)
  const [approving, setApproving] = useState<CreditTransferRow | null>(null)
  const [rejecting, setRejecting] = useState<CreditTransferRow | null>(null)

  const { data: rows, isLoading } = useQuery({
    queryKey: ['platform-credit-transfers'],
    queryFn: () => list(),
  })
  const pending = (rows ?? []).filter((r) => r.status === 'PENDING_PLATFORM_REVIEW').length

  return (
    <div>
      <PageHeader
        title="Credit Moves"
        description="Agency requests to move unused limit between two ad accounts of one client, where a pool account is involved."
      />
      <p className="mb-3 text-sm text-muted-foreground">
        {pending === 0 ? 'Nothing awaiting review.' : `${pending} awaiting review.`}
      </p>
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <Card className="overflow-x-auto p-0">
          <CreditTransfersTable
            rows={rows ?? []}
            showAgency
            actions={(t) =>
              t.status === 'PENDING_PLATFORM_REVIEW' ? (
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setRejecting(t)}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => setApproving(t)}>
                    Review
                  </Button>
                </div>
              ) : null
            }
          />
        </Card>
      )}

      {approving && (
        <ApproveDialog transfer={approving} onClose={() => setApproving(null)} />
      )}
      {rejecting && (
        <RejectDialog transfer={rejecting} onClose={() => setRejecting(null)} />
      )}
    </div>
  )
}

function ApproveDialog({ transfer, onClose }: { transfer: CreditTransferRow; onClose: () => void }) {
  const queryClient = useQueryClient()
  const preview = useServerFn(previewPlatformCreditTransferFn)
  const approve = useServerFn(approvePlatformCreditTransferFn)
  const { data: live, isFetching, error } = useQuery({
    queryKey: ['platform-credit-transfer-preview', transfer.id],
    queryFn: () => preview({ data: { id: transfer.id } }),
    retry: false,
    staleTime: 0,
  })
  const fits = live ? dec(String(transfer.amount_usd)).lte(dec(live.transferableUsd)) : false

  const mutation = useMutation({
    mutationFn: () => approve({ data: { id: transfer.id } }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['platform-credit-transfers'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
      if (r.meta.source === 'failed' || r.meta.destination === 'failed') {
        toast.warning(`${transfer.transfer_number} approved — Meta spend cap update pending`, {
          description: 'The limits moved; Meta will be updated by the automatic retry.',
        })
      } else {
        toast.success(`${transfer.transfer_number} approved and applied`)
      }
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to approve'),
  })

  const remaining = (s: { spend_cap: string | null; amount_spent: string | null; currency: string | null }) =>
    s.spend_cap == null
      ? 'No spend cap'
      : formatCurrencyAmount(dec(s.spend_cap).minus(dec(s.amount_spent ?? 0)).toFixed(2), s.currency)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {transfer.transfer_number}</DialogTitle>
          <DialogDescription>
            {transfer.organization?.name} asks to move {formatUsd(String(transfer.amount_usd))} from{' '}
            {transfer.source?.account_code} to {transfer.destination?.account_code} for{' '}
            {transfer.client?.name}.
          </DialogDescription>
        </DialogHeader>
        {transfer.note && (
          <p className="rounded-md bg-muted p-2 text-sm">“{transfer.note}”</p>
        )}
        <div className="rounded-md border p-3 text-sm">
          {isFetching ? (
            <Skeleton className="h-14 w-full" />
          ) : error ? (
            <p className="text-danger">{error instanceof Error ? error.message : 'Could not read Meta'}</p>
          ) : live ? (
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{live.source.account_code} remaining on Meta</dt>
              <dd className="num text-right">{remaining(live.source)}</dd>
              <dt className="text-muted-foreground">{live.destination.account_code} remaining on Meta</dt>
              <dd className="num text-right">{remaining(live.destination)}</dd>
              <dt className="font-medium">Can move now</dt>
              <dd className="num text-right font-medium">{formatUsd(live.transferableUsd)}</dd>
            </dl>
          ) : null}
        </div>
        {live && !fits && (
          <p className="text-sm text-danger">
            Only {formatUsd(live.transferableUsd)} can move now — reject this and ask the agency to send a new amount.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!fits || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Approve and move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RejectDialog({ transfer, onClose }: { transfer: CreditTransferRow; onClose: () => void }) {
  const queryClient = useQueryClient()
  const reject = useServerFn(rejectPlatformCreditTransferFn)
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: () => reject({ data: { id: transfer.id, reason } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-credit-transfers'] })
      toast.success(`${transfer.transfer_number} rejected`)
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to reject'),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject {transfer.transfer_number}</DialogTitle>
          <DialogDescription>Nothing moves. The agency sees your reason.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reject-reason">Reason</Label>
          <Textarea id="reject-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 3 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
