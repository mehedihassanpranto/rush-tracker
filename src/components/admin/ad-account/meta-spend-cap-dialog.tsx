import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import { fetchMetaAdAccountFn, updateMetaSpendCapFn } from '@/server/meta/meta.fns'
import { dec, formatCurrencyAmount } from '@/lib/money/money'
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

/**
 * Confirmation dialog for the one write this integration makes to Meta:
 * pushing a new spend_cap. Sensitive action (spec §74) — writes to a live
 * external system and can affect a real client's ad delivery, so this
 * always shows the current Meta state and a clear warning before the admin
 * confirms, even though the server independently enforces the same guard.
 *
 * Input is an increase amount, not an absolute new cap — same additive
 * model as the rest of the app's limit-request flow (spec §20: new limit =
 * opening balance + approved amount). The absolute new cap is computed here
 * and shown before submit, but that computed value — not the raw
 * increment — is what's actually sent to updateMetaSpendCapFn.
 */
export function MetaSpendCapDialog({
  open,
  onOpenChange,
  accountId,
  externalAccountId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountId: string
  externalAccountId: string | null
}) {
  const queryClient = useQueryClient()
  const fetchMetaAccount = useServerFn(fetchMetaAdAccountFn)
  const updateSpendCap = useServerFn(updateMetaSpendCapFn)
  const [increaseBy, setIncreaseBy] = useState('')

  const { data: meta, isLoading } = useQuery({
    queryKey: ['meta-live', externalAccountId],
    queryFn: () =>
      fetchMetaAccount({ data: { external_account_id: externalAccountId ?? '' } }),
    enabled: open && Boolean(externalAccountId),
  })

  useEffect(() => {
    if (open) setIncreaseBy('')
  }, [open])

  const currentCap = meta?.spend_cap != null ? dec(meta.spend_cap) : null
  const parsedIncrease =
    increaseBy.trim() !== '' && Number.isFinite(Number(increaseBy))
      ? dec(increaseBy)
      : null
  const newCap =
    currentCap && parsedIncrease ? currentCap.plus(parsedIncrease) : null

  const mutation = useMutation({
    mutationFn: () =>
      updateSpendCap({
        data: { id: accountId, spend_cap_usd: Number(newCap!.toFixed(2)) },
      }),
    onSuccess: () => {
      toast.success('Spend cap updated on Meta')
      void queryClient.invalidateQueries({ queryKey: ['ad-account', accountId] })
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['meta-live', externalAccountId] })
      void queryClient.invalidateQueries({ queryKey: ['meta-business-ad-accounts'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to update spend cap'),
  })

  const isUsd = meta?.currency === 'USD'
  const amountSpent = meta ? dec(meta.amount_spent ?? 0) : null
  const belowSpent = amountSpent && newCap ? newCap.lt(amountSpent) : false
  const canSubmit =
    isUsd &&
    parsedIncrease &&
    parsedIncrease.gt(0) &&
    newCap &&
    !belowSpent &&
    !mutation.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Meta spend cap</DialogTitle>
          <DialogDescription>
            Writes directly to this account's Meta ad account settings — takes
            effect immediately. Also updates this account's current limit
            here to match.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <Skeleton className="h-32 w-full" />}

        {meta && !isUsd && (
          <p className="text-sm text-muted-foreground">
            Meta reports this account's currency as {meta.currency ?? 'unknown'},
            not USD — this app can't push a spend cap to a non-USD account.
          </p>
        )}

        {meta && isUsd && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 rounded-md border p-3 text-sm">
              <div>
                <div className="text-muted-foreground">Current spend cap</div>
                <div className="font-medium">
                  {formatCurrencyAmount(meta.spend_cap, meta.currency)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Already spent</div>
                <div className="font-medium">
                  {formatCurrencyAmount(meta.amount_spent, meta.currency)}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Increase spend cap by (USD)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={increaseBy}
                onChange={(e) => setIncreaseBy(e.target.value)}
              />
            </div>

            {newCap && (
              <div className="rounded-md border bg-muted/50 p-3 text-sm">
                <div className="text-muted-foreground">New spend cap</div>
                <div className="text-lg font-medium">
                  {formatCurrencyAmount(newCap.toFixed(2), meta.currency)}
                </div>
              </div>
            )}

            {belowSpent && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  The new spend cap would still be below the $
                  {amountSpent?.toFixed(2)} already spent — Meta would pause
                  all delivery on this account immediately. Choose a larger
                  increase.
                </span>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Update on Meta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
