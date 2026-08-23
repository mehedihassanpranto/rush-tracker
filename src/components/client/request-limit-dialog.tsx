import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import {
  createLimitRequestFn,
  listMyRequestableAccountsFn,
} from '@/server/limit-requests/limit-request.fns'
import { addUsd, dec, formatBdt, formatUsd, multiplyUsdByRate } from '@/lib/money/money'
import { ALLOWED_PROOF_MIME, MAX_PROOF_BYTES } from '@/schemas/limit-request'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Client limit request (spec §21). Shows opening balance and the expected new
 * limit live; submitting only creates a PENDING request — no due changes.
 */
export function RequestLimitDialog({
  open,
  onOpenChange,
  presetAccountId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presetAccountId?: string
}) {
  const queryClient = useQueryClient()
  const listAccounts = useServerFn(listMyRequestableAccountsFn)
  const createRequest = useServerFn(createLimitRequestFn)
  const fileRef = useRef<HTMLInputElement>(null)

  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const { data: result } = useQuery({
    queryKey: ['my-requestable-accounts'],
    queryFn: () => listAccounts(),
    enabled: open,
  })
  const accounts = result?.accounts
  const isPrepaid = result?.segment === 'prepaid'
  const [amountPaid, setAmountPaid] = useState('')
  const [paidTouched, setPaidTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setAccountId(presetAccountId ?? '')
      setAmount('')
      setAmountPaid('')
      setPaidTouched(false)
      setFile(null)
    }
  }, [open, presetAccountId])

  // Accounts eligible to receive a request: active and no pending request.
  const eligible = useMemo(
    () => (accounts ?? []).filter((a) => a.status === 'ACTIVE' && !a.has_pending),
    [accounts],
  )
  const selected = accounts?.find((a) => a.id === accountId)

  const amountNum = Number(amount)
  const amountValid = amount !== '' && Number.isFinite(amountNum) && amountNum > 0
  const expected =
    selected && amountValid
      ? addUsd(selected.current_limit_usd, amountNum).toString()
      : null
  // Automatically computed, not editable by the client — same rate
  // resolution and rounding the approval RPC uses (adAccountUsdRate,
  // round(amount * rate, 2)), shown here only as a preview of what they'll
  // be charged.
  const chargeBdt =
    selected && amountValid && Number(selected.usd_rate) > 0
      ? multiplyUsdByRate(amountNum, selected.usd_rate).toString()
      : null

  // Prepaid only: pre-fill "amount paid" with the full cost whenever it
  // changes, but stop overwriting once the client has manually edited it
  // (they can pay less than the full amount — the rest becomes due).
  useEffect(() => {
    if (isPrepaid && chargeBdt && !paidTouched) setAmountPaid(chargeBdt)
  }, [isPrepaid, chargeBdt, paidTouched])

  const amountPaidNum = Number(amountPaid)
  const amountPaidValid =
    !isPrepaid ||
    (amountPaid !== '' &&
      Number.isFinite(amountPaidNum) &&
      amountPaidNum > 0 &&
      chargeBdt !== null &&
      amountPaidNum <= Number(chargeBdt))
  const dueBalance =
    isPrepaid && chargeBdt && amountPaidValid
      ? dec(chargeBdt).minus(amountPaidNum).toFixed(2)
      : null

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

  const mutation = useMutation({
    mutationFn: async () => {
      if (!isPrepaid) {
        return createRequest({
          data: { ad_account_id: accountId, requested_amount_usd: amountNum },
        })
      }
      if (!file) throw new Error('Attach payment proof')
      const data_base64 = await fileToBase64(file)
      return createRequest({
        data: {
          ad_account_id: accountId,
          requested_amount_usd: amountNum,
          amount_paid_bdt: amountPaidNum,
          file_name: file.name,
          mime_type: file.type as (typeof ALLOWED_PROOF_MIME)[number],
          data_base64,
        },
      })
    },
    onSuccess: (req) => {
      toast.success(`Request ${req.request_number} submitted`)
      void queryClient.invalidateQueries({ queryKey: ['my-limit-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['my-requestable-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['client-dashboard-stats'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to submit'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request a limit increase</DialogTitle>
          <DialogDescription>
            Your request is reviewed by the team. Nothing is billed until it is
            approved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Ad account</Label>
            <Select
              value={accountId}
              onValueChange={setAccountId}
              disabled={Boolean(presetAccountId)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.account_code} — {a.name}
                  </SelectItem>
                ))}
                {eligible.length === 0 && (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    No eligible accounts
                  </div>
                )}
              </SelectContent>
            </Select>
            {presetAccountId && selected?.has_pending && (
              <p className="text-xs text-amber-600">
                This account already has a pending request.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Requested amount (USD)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="200"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          {selected && (
            <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/40 p-3 text-sm">
              <div>
                <div className="text-muted-foreground">Opening balance</div>
                <div className="font-medium">
                  {formatUsd(selected.current_limit_usd)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Expected new limit</div>
                <div className="font-medium">
                  {expected ? formatUsd(expected) : '—'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Rate</div>
                <div className="font-medium">
                  {Number(selected.usd_rate) > 0 ? `৳${selected.usd_rate}` : '—'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Total cost</div>
                <div className="font-medium">
                  {chargeBdt ? formatBdt(chargeBdt) : '—'}
                </div>
              </div>
            </div>
          )}

          {isPrepaid ? (
            <>
              <div className="space-y-2">
                <Label>Amount paid (BDT)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amountPaid}
                  onChange={(e) => {
                    setPaidTouched(true)
                    setAmountPaid(e.target.value)
                  }}
                />
                {chargeBdt && amountPaidValid && dueBalance && (
                  <p
                    className={
                      Number(dueBalance) <= 0
                        ? 'text-xs text-emerald-600'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {Number(dueBalance) <= 0
                      ? 'Fully paid'
                      : `Due balance: ${formatBdt(dueBalance)}`}
                  </p>
                )}
                {amountPaid !== '' && !amountPaidValid && (
                  <p className="text-xs text-destructive">
                    Enter an amount greater than 0
                    {chargeBdt ? ` and up to ${formatBdt(chargeBdt)}` : ''}.
                  </p>
                )}
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
                  Pay the amount above, then upload proof (JPG, PNG, WEBP or
                  PDF, up to {formatFileSize(MAX_PROOF_BYTES)}). Required.
                </p>
              </div>
            </>
          ) : (
            selected && (
              <p className="text-xs text-muted-foreground">
                No payment needed now — the full amount will be added to
                your due balance once approved.
              </p>
            )
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !accountId ||
              !amountValid ||
              selected?.has_pending ||
              selected?.status !== 'ACTIVE' ||
              mutation.isPending ||
              (isPrepaid && (!file || !amountPaidValid))
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
