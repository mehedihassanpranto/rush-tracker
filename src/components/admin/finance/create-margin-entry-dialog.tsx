import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createUsdMarginEntryFn } from '@/server/finance/finance.fns'
import { dec } from '@/lib/money/money'
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Records one USD transaction: USD amount, buying rate, selling rate.
 * Buying/selling amounts and the margin are all computed from those (both
 * here, as a live preview, and again by the database's generated columns —
 * never sent from the client).
 */
export function CreateMarginEntryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const createEntry = useServerFn(createUsdMarginEntryFn)

  const [transactionDate, setTransactionDate] = useState(todayIso())
  const [usdAmount, setUsdAmount] = useState('')
  const [buyingRate, setBuyingRate] = useState('')
  const [sellingRate, setSellingRate] = useState('')

  useEffect(() => {
    if (open) {
      setTransactionDate(todayIso())
      setUsdAmount('')
      setBuyingRate('')
      setSellingRate('')
    }
  }, [open])

  const amountNum = Number(usdAmount)
  const buyingRateNum = Number(buyingRate)
  const sellingRateNum = Number(sellingRate)
  const numbersValid =
    usdAmount !== '' &&
    buyingRate !== '' &&
    sellingRate !== '' &&
    Number.isFinite(amountNum) &&
    amountNum > 0 &&
    Number.isFinite(buyingRateNum) &&
    buyingRateNum > 0 &&
    Number.isFinite(sellingRateNum) &&
    sellingRateNum > 0
  const valid = numbersValid && transactionDate !== ''

  const amountKnown = usdAmount !== '' && Number.isFinite(amountNum) && amountNum > 0
  const buyingRateKnown =
    buyingRate !== '' && Number.isFinite(buyingRateNum) && buyingRateNum > 0
  const sellingRateKnown =
    sellingRate !== '' && Number.isFinite(sellingRateNum) && sellingRateNum > 0

  // Each amount updates the instant its own rate is known — doesn't wait on
  // the other rate being filled in too.
  const buyingAmount =
    amountKnown && buyingRateKnown
      ? dec(amountNum).mul(dec(buyingRateNum)).toDecimalPlaces(2)
      : null
  const sellingAmount =
    amountKnown && sellingRateKnown
      ? dec(amountNum).mul(dec(sellingRateNum)).toDecimalPlaces(2)
      : null
  const previewMargin =
    buyingAmount && sellingAmount ? sellingAmount.minus(buyingAmount) : null

  const mutation = useMutation({
    mutationFn: () =>
      createEntry({
        data: {
          transaction_date: transactionDate,
          usd_amount: amountNum,
          buying_rate: buyingRateNum,
          selling_rate: sellingRateNum,
        },
      }),
    onSuccess: () => {
      toast.success('Margin entry recorded')
      void queryClient.invalidateQueries({ queryKey: ['usd-margin-entries'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a USD transaction</DialogTitle>
          <DialogDescription>
            Enter the USD amount and the two rates — amounts and margin are
            worked out automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Date</Label>
            <Input
              type="date"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>USD amount</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={usdAmount}
              onChange={(e) => setUsdAmount(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Buying rate (BDT per USD)</Label>
              <Input
                type="number"
                min="0"
                step="0.0001"
                value={buyingRate}
                onChange={(e) => setBuyingRate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Buying amount (BDT)</Label>
              <Input
                disabled
                value={buyingAmount ? buyingAmount.toFixed(2) : '0.00'}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Selling rate (BDT per USD)</Label>
              <Input
                type="number"
                min="0"
                step="0.0001"
                value={sellingRate}
                onChange={(e) => setSellingRate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Selling amount (BDT)</Label>
              <Input
                disabled
                value={sellingAmount ? sellingAmount.toFixed(2) : '0.00'}
              />
            </div>
          </div>

          {previewMargin && (
            <p className="text-sm">
              Margin:{' '}
              <span
                className={
                  previewMargin.isNegative()
                    ? 'font-medium text-danger'
                    : 'font-medium text-success'
                }
              >
                ৳{previewMargin.toFixed(2)}
              </span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
