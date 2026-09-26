import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createUsdPurchaseFn, listUsdSourcesFn } from '@/server/platform/finance.fns'
import { dec } from '@/lib/money/money'
import { fmtRate, localInputToIso, nowLocalInput } from '@/components/platform/finance/format'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

/**
 * Records USD the platform bought: how many dollars, and how much BDT it paid.
 * The rate is worked out from the two — never typed — because each purchase
 * can carry a different one (spec §6.1).
 */
export function AddPurchaseDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const listSources = useServerFn(listUsdSourcesFn)
  const createPurchase = useServerFn(createUsdPurchaseFn)

  const [sourceId, setSourceId] = useState('')
  const [method, setMethod] = useState('')
  const [usd, setUsd] = useState('')
  const [bdt, setBdt] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) {
      setSourceId('')
      setMethod('')
      setUsd('')
      setBdt('')
      setWhen(nowLocalInput())
      setNotes('')
    }
  }, [open])

  const { data: sources, isLoading } = useQuery({
    queryKey: ['platform-usd', 'sources'],
    queryFn: () => listSources(),
    enabled: open,
  })
  const active = (sources ?? []).filter((s) => s.is_active)

  const usdNum = Number(usd)
  const bdtNum = Number(bdt)
  const usdOk = usd !== '' && Number.isFinite(usdNum) && usdNum > 0
  const bdtOk = bdt !== '' && Number.isFinite(bdtNum) && bdtNum > 0
  const rate = usdOk && bdtOk ? dec(bdtNum).div(dec(usdNum)) : null
  const valid = sourceId !== '' && usdOk && bdtOk && when !== ''

  const mutation = useMutation({
    mutationFn: () =>
      createPurchase({
        data: {
          source_id: sourceId,
          usd_amount: usdNum,
          bdt_amount: bdtNum,
          method: method || undefined,
          purchased_at: localInputToIso(when),
          notes: notes || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('USD purchase recorded')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add USD purchase</DialogTitle>
          <DialogDescription>
            Dollars the platform bought and the BDT it paid. The buying rate is
            worked out from the two.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="purchase-source">Source</Label>
            {!isLoading && active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                There is no active source yet. Add one from the Source Summary
                tab first.
              </p>
            ) : (
              <Select value={sourceId} onValueChange={setSourceId}>
                <SelectTrigger id="purchase-source">
                  <SelectValue placeholder={isLoading ? 'Loading…' : 'Choose a source'} />
                </SelectTrigger>
                <SelectContent>
                  {active.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.payment_method ? `${s.name} · ${s.payment_method}` : s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="purchase-method">Method (optional)</Label>
            <Input
              id="purchase-method"
              value={method}
              maxLength={100}
              placeholder="Bank transfer, cash…"
              onChange={(e) => setMethod(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="purchase-usd">USD bought</Label>
              <Input
                id="purchase-usd"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={usd}
                onChange={(e) => setUsd(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="purchase-bdt">BDT paid</Label>
              <Input
                id="purchase-bdt"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={bdt}
                onChange={(e) => setBdt(e.target.value)}
              />
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Buying rate:{' '}
            <span className="num font-medium text-foreground">
              {rate ? `৳${fmtRate(rate)}` : '—'}
            </span>{' '}
            per USD
          </p>

          <div className="space-y-2">
            <Label htmlFor="purchase-when">Purchased</Label>
            <Input
              id="purchase-when"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="purchase-notes">Notes (optional)</Label>
            <Textarea
              id="purchase-notes"
              rows={2}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Record purchase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
