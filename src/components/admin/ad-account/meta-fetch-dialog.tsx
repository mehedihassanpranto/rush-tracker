import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { applyMetaSpendCapFn, fetchMetaAdAccountFn } from '@/server/meta/meta.fns'
import { formatUsd } from '@/lib/money/money'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { MetaAdAccountSummary } from '@/server/meta/meta.server'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2">{value || '—'}</dd>
    </div>
  )
}

/** "Verify against Meta" dialog for an already-created ad account. Fetching
 * is always read-only; applying the spend cap as current_limit_usd is a
 * separate, explicit action (never automatic). */
export function MetaFetchDialog({
  open,
  onOpenChange,
  accountId,
  externalAccountId,
  currentLimitUsd,
  canApplySpendCap = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountId: string
  externalAccountId: string | null
  currentLimitUsd: string
  /** False for a platform-assigned account viewed by a non-platform-admin —
   * see canMutateSpendCap() in credential-scope.ts. Fetching stays read-only
   * and available either way; only the write below is restricted. Defaults
   * true so every other caller (none currently non-agency) is unaffected. */
  canApplySpendCap?: boolean
}) {
  const queryClient = useQueryClient()
  const fetchAccount = useServerFn(fetchMetaAdAccountFn)
  const applySpendCap = useServerFn(applyMetaSpendCapFn)
  const [result, setResult] = useState<MetaAdAccountSummary | null>(null)

  const mutation = useMutation({
    mutationFn: () =>
      fetchAccount({ data: { external_account_id: externalAccountId ?? '' } }),
    onSuccess: (data) => setResult(data),
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to fetch from Meta')
      onOpenChange(false)
    },
  })

  const applyMutation = useMutation({
    mutationFn: () => applySpendCap({ data: { id: accountId } }),
    onSuccess: () => {
      toast.success('Current limit updated from Meta spend cap')
      void queryClient.invalidateQueries({ queryKey: ['ad-account', accountId] })
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to apply spend cap'),
  })

  const canApply =
    canApplySpendCap && result?.currency === 'USD' && result.spend_cap != null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setResult(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Meta ad account</DialogTitle>
          <DialogDescription>
            Live data from the connected Business Portfolio. Fetching is
            read-only; applying the spend cap below is a separate, explicit
            step — nothing here overwrites this account until you choose to.
          </DialogDescription>
        </DialogHeader>

        {!result && !mutation.isPending && (
          <Button onClick={() => mutation.mutate()} className="w-full">
            <RefreshCw className="size-4" />
            Fetch from Meta
          </Button>
        )}
        {mutation.isPending && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {result && (
          <>
            <dl className="divide-y">
              <Row label="Name" value={result.name} />
              <Row label="Account ID" value={result.external_account_id} />
              <Row label="Meta status" value={result.meta_status_label} />
              <Row label="Currency" value={result.currency} />
              <Row label="Amount spent" value={result.amount_spent} />
              <Row label="Spend cap" value={result.spend_cap} />
            </dl>

            {canApply ? (
              <div className="rounded-md border p-3 text-sm">
                <p className="mb-2 text-muted-foreground">
                  Set this account's current limit to Meta's spend cap —
                  changes the operational baseline used for the next limit
                  request (spec §20). This does not create billing or a
                  ledger entry, same as editing it directly.
                </p>
                <p className="mb-3">
                  {formatUsd(currentLimitUsd)}{' '}
                  <span className="text-muted-foreground">→</span>{' '}
                  <span className="font-medium">{formatUsd(result.spend_cap!)}</span>
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
            ) : (
              result.spend_cap != null &&
              (canApplySpendCap ? (
                <p className="text-xs text-muted-foreground">
                  Currency is {result.currency ?? 'unknown'}, not USD — apply
                  this limit manually via Edit details.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This account's spend cap is managed by the platform —
                  applying it here isn't available.
                </p>
              ))
            )}
          </>
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
