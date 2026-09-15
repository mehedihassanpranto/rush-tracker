import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { CheckCircle2, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import {
  applyPoolAccountSpendCapFn,
  fetchPoolAccountMetaFn,
  updatePoolAccountSpendCapFn,
} from '@/server/platform/pool.fns'
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
 * The platform-side counterpart of the agency's MetaFetchDialog +
 * MetaSpendCapDialog, combined into one — a pool account has no detail page
 * to spread across tabs the way an agency account does, so both actions
 * ("apply Meta's live cap" and "push a new cap to Meta") live in the same
 * dialog here.
 *
 * This is the release valve for canMutateSpendCap()'s restriction: these are
 * the only 3 write paths (fetch is read-only) a platform admin has for a
 * pool account's spend cap, wherever it's currently granted or not.
 */
export function PoolSpendCapDialog({
  open,
  onOpenChange,
  accountId,
  accountLabel,
  currentLimitUsd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountId: string
  accountLabel: string
  currentLimitUsd: string
}) {
  const queryClient = useQueryClient()
  const fetchMeta = useServerFn(fetchPoolAccountMetaFn)
  const applySpendCap = useServerFn(applyPoolAccountSpendCapFn)
  const updateSpendCap = useServerFn(updatePoolAccountSpendCapFn)
  const [increaseBy, setIncreaseBy] = useState('')

  const { data: meta, isLoading, error } = useQuery({
    queryKey: ['pool-account-meta-live', accountId],
    queryFn: () => fetchMeta({ data: { id: accountId } }),
    enabled: open,
    retry: false,
  })

  useEffect(() => {
    if (open) setIncreaseBy('')
  }, [open])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
    void queryClient.invalidateQueries({ queryKey: ['pool-account-meta-live', accountId] })
  }

  const applyMutation = useMutation({
    mutationFn: () => applySpendCap({ data: { id: accountId } }),
    onSuccess: () => {
      toast.success('Current limit updated from Meta spend cap')
      invalidate()
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to apply spend cap'),
  })

  const currentCap = meta?.spend_cap != null ? dec(meta.spend_cap) : null
  const parsedIncrease =
    increaseBy.trim() !== '' && Number.isFinite(Number(increaseBy))
      ? dec(increaseBy)
      : null
  const newCap = currentCap && parsedIncrease ? currentCap.plus(parsedIncrease) : null
  const amountSpent = meta ? dec(meta.amount_spent ?? 0) : null
  const belowSpent = amountSpent && newCap ? newCap.lt(amountSpent) : false

  const updateMutation = useMutation({
    mutationFn: () =>
      updateSpendCap({
        data: { id: accountId, increase_by_usd: Number(parsedIncrease!.toFixed(2)) },
      }),
    onSuccess: () => {
      toast.success('Spend cap updated on Meta')
      invalidate()
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to update spend cap'),
  })

  const isUsd = meta?.currency === 'USD'
  const canApply = isUsd && meta?.spend_cap != null
  const canUpdate =
    isUsd && parsedIncrease && parsedIncrease.gt(0) && newCap && !belowSpent

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Meta spend cap — {accountLabel}</DialogTitle>
          <DialogDescription>
            Live data from the platform's Business Portfolio. Fetching is
            read-only; both actions below write immediately once confirmed.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <Skeleton className="h-32 w-full" />}

        {!isLoading && error && (
          <p className="text-sm text-danger">
            {error instanceof Error ? error.message : "Couldn't reach Meta."}
          </p>
        )}

        {meta && !isUsd && (
          <p className="text-sm text-muted-foreground">
            Meta reports this account's currency as {meta.currency ?? 'unknown'},
            not USD — this app can't push or apply a spend cap for a non-USD
            account.
          </p>
        )}

        {meta && isUsd && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 rounded-md border p-3 text-sm">
              <div>
                <div className="text-muted-foreground">Spend cap</div>
                <div className="num font-medium">
                  {formatCurrencyAmount(meta.spend_cap, meta.currency)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Already spent</div>
                <div className="num font-medium">
                  {formatCurrencyAmount(meta.amount_spent, meta.currency)}
                </div>
              </div>
            </div>

            {canApply && (
              <div className="rounded-md border p-3 text-sm">
                <p className="mb-2 text-muted-foreground">
                  Set this account's stored current limit to Meta's live
                  spend cap — a local baseline change, no write to Meta.
                </p>
                <p className="mb-3">
                  {formatCurrencyAmount(currentLimitUsd, 'USD')}{' '}
                  <span className="text-muted-foreground">→</span>{' '}
                  <span className="font-medium">
                    {formatCurrencyAmount(meta.spend_cap, meta.currency)}
                  </span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={applyMutation.isPending}
                  onClick={() => applyMutation.mutate()}
                >
                  {applyMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  Apply as current limit
                </Button>
              </div>
            )}

            <div className="space-y-2 rounded-md border p-3">
              <Label>Increase spend cap on Meta by (USD)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={increaseBy}
                onChange={(e) => setIncreaseBy(e.target.value)}
              />
              {newCap && (
                <p className="text-xs text-muted-foreground">
                  Estimated new cap: {formatCurrencyAmount(newCap.toFixed(2), 'USD')} —
                  recomputed fresh from Meta on submit.
                </p>
              )}
              {belowSpent && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Below the ${amountSpent?.toFixed(2)} already spent — Meta
                    would pause delivery immediately.
                  </span>
                </div>
              )}
              <Button
                size="sm"
                disabled={!canUpdate || updateMutation.isPending}
                onClick={() => updateMutation.mutate()}
              >
                {updateMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Update on Meta
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
