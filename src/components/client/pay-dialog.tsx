import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { submitPaymentFn } from '@/server/payments/payment.fns'
import { formatBdt } from '@/lib/money/money'
import {
  ALLOWED_PROOF_MIME,
  MAX_PROOF_BYTES,
} from '@/schemas/limit-request'
import { PAYMENT_METHODS } from '@/schemas/payment'
import { fileToBase64, formatFileSize } from '@/lib/utils/file'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Client submits a payment with proof (spec §42, §44). While pending, the due
 * does not change. Amount cannot exceed the outstanding shown.
 */
export function PayDialog({
  open,
  onOpenChange,
  outstanding,
  presetAmount,
  paymentRequestId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  outstanding: string
  presetAmount?: string
  paymentRequestId?: string
}) {
  const queryClient = useQueryClient()
  const submit = useServerFn(submitPaymentFn)
  const fileRef = useRef<HTMLInputElement>(null)

  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('bKash')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)

  useEffect(() => {
    if (open) {
      setAmount(presetAmount ?? outstanding)
      setMethod('bKash')
      setReference('')
      setNote('')
      setFile(null)
    }
  }, [open, presetAmount, outstanding])

  const amountNum = Number(amount)
  const outstandingNum = Number(outstanding)
  const amountValid =
    amount !== '' &&
    Number.isFinite(amountNum) &&
    amountNum > 0 &&
    amountNum <= outstandingNum
  const canSubmit = amountValid && file !== null

  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Attach a proof')
      const data_base64 = await fileToBase64(file)
      return submit({
        data: {
          amount_bdt: amountNum,
          payment_method: method,
          transaction_reference: reference || undefined,
          note: note || undefined,
          payment_request_id: paymentRequestId,
          file_name: file.name,
          mime_type: file.type as (typeof ALLOWED_PROOF_MIME)[number],
          data_base64,
        },
      })
    },
    onSuccess: (payment) => {
      toast.success(`Payment ${payment.payment_number} submitted for review`)
      void queryClient.invalidateQueries({ queryKey: ['my-due'] })
      void queryClient.invalidateQueries({ queryKey: ['my-payments'] })
      void queryClient.invalidateQueries({ queryKey: ['my-payment-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['client-dashboard-stats'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (!ALLOWED_PROOF_MIME.includes(f.type as never)) {
      toast.error('Use JPG, PNG, WEBP or PDF')
      return
    }
    if (f.size > MAX_PROOF_BYTES) {
      toast.error('File must be 3 MB or smaller')
      return
    }
    setFile(f)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make a payment</DialogTitle>
          <DialogDescription>
            Outstanding due: {formatBdt(outstanding)}. Your payment is reviewed
            before it reduces your due.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Amount (BDT)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {amount !== '' && !amountValid && (
                <p className="text-xs text-destructive">
                  Enter an amount up to {formatBdt(outstanding)}.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Method</Label>
              <Select
                value={method}
                onValueChange={(v) =>
                  setMethod(v as (typeof PAYMENT_METHODS)[number])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Transaction reference (optional)</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Payment proof</Label>
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
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="size-4" />
                {file ? 'Change file' : 'Choose file'}
              </Button>
              {file && (
                <span className="truncate text-sm text-muted-foreground">
                  {file.name}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              JPG, PNG, WEBP or PDF, up to {formatFileSize(MAX_PROOF_BYTES)}.
              Required.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Note (optional)</Label>
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Submit payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
