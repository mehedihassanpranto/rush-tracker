import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  createCreditTransferFn,
  listTransferTargetsFn,
  previewCreditTransferFn,
} from '@/server/credit-transfers/credit-transfer.fns'
import { dec, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { Button } from '@/components/ui/button'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Move unused limit from this ad account to another account of the same
 * client (credit transfer, migration 000058). Called "Move credit" in the UI
 * so it's never confused with Transfer (moving the account to another client).
 * Figures are read live from Meta when a destination is picked; the server
 * re-reads them before writing.
 */
export function MoveCreditDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: { id: string; account_code: string; name: string }
}) {
  const queryClient = useQueryClient()
  const listTargets = useServerFn(listTransferTargetsFn)
  const preview = useServerFn(previewCreditTransferFn)
  const create = useServerFn(createCreditTransferFn)
  const [destinationId, setDestinationId] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open) {
      setDestinationId('')
      setAmount('')
      setNote('')
    }
  }, [open])

  const { data: targets, isLoading: targetsLoading } = useQuery({
    queryKey: ['credit-transfer-targets', account.id],
    queryFn: () => listTargets({ data: { source_id: account.id } }),
    enabled: open,
  })
  const destination = targets?.targets.find((t) => t.id === destinationId)
  const involvesPool = Boolean(targets?.source_is_platform || destination?.is_platform)

  const {
    data: live,
    isFetching: liveLoading,
    error: liveError,
  } = useQuery({
    queryKey: ['credit-transfer-preview', account.id, destinationId],
    queryFn: () => preview({ data: { source_id: account.id, destination_id: destinationId } }),
    enabled: open && Boolean(destinationId),
    retry: false,
    staleTime: 0,
  })

  const amountNum = Number(amount)
  const tooMuch = live ? amountNum > 0 && dec(amount || 0).gt(dec(live.transferableUsd)) : false
  const canSubmit = Boolean(live) && amountNum > 0 && !tooMuch

  const mutation = useMutation({
    mutationFn: () =>
      create({
        data: {
          source_id: account.id,
          destination_id: destinationId,
          amount_usd: amountNum,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: (r) => {
      for (const id of [account.id, destinationId]) {
        void queryClient.invalidateQueries({ queryKey: ['ad-account', id] })
        void queryClient.invalidateQueries({ queryKey: ['credit-transfers', id] })
        void queryClient.invalidateQueries({ queryKey: ['assignment-history', id] })
      }
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      if (r.status === 'PENDING_PLATFORM_REVIEW') {
        toast.success(`${r.transfer_number} sent to the platform for approval`)
      } else if (r.meta && (r.meta.source === 'failed' || r.meta.destination === 'failed')) {
        toast.warning(`${r.transfer_number} done — Meta spend cap update pending`, {
          description: 'The limits moved; Meta will be updated by the automatic retry. See the account for details.',
        })
      } else {
        toast.success(`${r.transfer_number}: ${formatUsd(String(amountNum))} moved`)
      }
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to move credit'),
  })

  const remaining = (s: { spend_cap: string | null; amount_spent: string | null; currency: string | null }) =>
    s.spend_cap == null
      ? 'No spend cap'
      : formatCurrencyAmount(dec(s.spend_cap).minus(dec(s.amount_spent ?? 0)).toFixed(2), s.currency)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move credit</DialogTitle>
          <DialogDescription>
            Move unused limit from {account.account_code} to another ad account of
            the same client. The client&apos;s due doesn&apos;t change.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Move to</Label>
            {targetsLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (targets?.targets.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                {targets?.client
                  ? `${targets.client.name} has no other active ad account to move credit to.`
                  : 'This account is not assigned to a client.'}
              </p>
            ) : (
              <Select value={destinationId} onValueChange={setDestinationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an ad account" />
                </SelectTrigger>
                <SelectContent>
                  {targets?.targets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.account_code} — {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {destinationId && (
            <div className="rounded-md border p-3 text-sm">
              {liveLoading ? (
                <Skeleton className="h-14 w-full" />
              ) : liveError ? (
                <p className="text-danger">
                  {liveError instanceof Error ? liveError.message : 'Could not read Meta'}
                </p>
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
          )}

          <div className="space-y-2">
            <Label htmlFor="move-credit-amount">Amount (USD)</Label>
            <Input
              id="move-credit-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={!live}
            />
            {tooMuch && (
              <p className="text-xs text-danger">
                At most {formatUsd(live!.transferableUsd)} can move right now.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="move-credit-note">Note (optional)</Label>
            <Textarea
              id="move-credit-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {involvesPool && (
            <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
              A platform pool account is involved, so this goes to the platform for
              approval. Nothing moves until it&apos;s approved.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {involvesPool ? 'Send for approval' : 'Move credit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
