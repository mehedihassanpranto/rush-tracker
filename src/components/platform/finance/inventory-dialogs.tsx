import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  listPlatformAdAccountsForBillsFn,
  postUsdOutflowFn,
  setOpeningStockFn,
} from '@/server/platform/usd-inventory.fns'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { localInputToIso, nowLocalInput } from '@/components/platform/finance/format'
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
 * Dollars leaving the platform's inventory. Under the owner's model
 * (2026-10-20) that is a Meta bill being paid for a pool account — a sale to
 * an agency is revenue and does not move stock. Drawn oldest batch first; the
 * FIFO cost comes back from the database.
 */
type OutflowKindChoice = 'META_BILL_PAYMENT' | 'META_PREPAID_FUNDING' | 'OTHER'

export function OutflowDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Opened from one account's row (Meta Accounts tab): kind and account fixed. */
  preset?: { kind: Exclude<OutflowKindChoice, 'OTHER'>; accountId: string } | null
}) {
  const queryClient = useQueryClient()
  const listAccounts = useServerFn(listPlatformAdAccountsForBillsFn)
  const post = useServerFn(postUsdOutflowFn)

  const [kind, setKind] = useState<OutflowKindChoice>('META_BILL_PAYMENT')
  const [accountId, setAccountId] = useState('')
  const [usd, setUsd] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [notes, setNotes] = useState('')
  // One key per opening of the dialog: a double-click or a retry after a
  // dropped response posts once.
  const [key, setKey] = useState('')

  useEffect(() => {
    if (open) {
      setKind(preset?.kind ?? 'META_BILL_PAYMENT')
      setAccountId(preset?.accountId ?? '')
      setUsd('')
      setWhen(nowLocalInput())
      setNotes('')
      setKey(crypto.randomUUID())
    }
  }, [open, preset?.kind, preset?.accountId])

  const accounts = useQuery({
    queryKey: ['platform-usd', 'bill-accounts'],
    queryFn: () => listAccounts(),
    enabled: open,
  })

  const usdNum = Number(usd)
  const valid =
    usd !== '' &&
    usdNum > 0 &&
    when !== '' &&
    (kind === 'OTHER' ? notes.trim() !== '' : accountId !== '')

  const mutation = useMutation({
    mutationFn: () =>
      post({
        data: {
          kind,
          usd_amount: usdNum,
          event_at: localInputToIso(when),
          ad_account_id: kind === 'OTHER' ? undefined : accountId,
          notes: notes || undefined,
          idempotency_key: key,
        },
      }),
    onSuccess: (r) => {
      toast.success(`Recorded — FIFO cost ${formatBdt(r.bdt_cost)}`)
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === 'META_PREPAID_FUNDING' ? 'Fund a prepaid Meta account' : 'Record USD paid out'}
          </DialogTitle>
          <DialogDescription>
            Dollars that left your wallets. They are taken from the oldest
            batch first, and the BDT they cost is worked out from those batches.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="outflow-kind">What was it</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)} disabled={!!preset}>
              <SelectTrigger id="outflow-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="META_BILL_PAYMENT">Meta bill paid</SelectItem>
                <SelectItem value="META_PREPAID_FUNDING">Prepaid Meta funding</SelectItem>
                <SelectItem value="OTHER">Something else</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind !== 'OTHER' && (
            <div className="space-y-2">
              <Label htmlFor="outflow-account">Ad account</Label>
              <Select value={accountId} onValueChange={setAccountId} disabled={!!preset}>
                <SelectTrigger id="outflow-account">
                  <SelectValue placeholder={accounts.isLoading ? 'Loading…' : 'Choose the pool account'} />
                </SelectTrigger>
                <SelectContent>
                  {(accounts.data ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.account_code} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="outflow-usd">
                {kind === 'META_PREPAID_FUNDING' ? 'USD loaded' : 'USD paid'}
              </Label>
              <Input
                id="outflow-usd"
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
              <Label htmlFor="outflow-when">Paid</Label>
              <Input
                id="outflow-when"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="outflow-notes">
              {kind === 'OTHER' ? 'What was it for' : 'Notes (optional)'}
            </Label>
            <Textarea
              id="outflow-notes"
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
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Cut-over to FIFO: purchases recorded before v2 all still count as in stock.
 * The owner enters what is really in the wallets now; the gap is posted once
 * as an opening adjustment, oldest batches first.
 */
export function OpeningStockDialog({
  open,
  onOpenChange,
  recordedUsd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  recordedUsd: string
}) {
  const queryClient = useQueryClient()
  const setOpening = useServerFn(setOpeningStockFn)
  const [onHand, setOnHand] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) {
      setOnHand('')
      setWhen(nowLocalInput())
      setNotes('')
    }
  }, [open])

  const n = Number(onHand)
  const valid = onHand !== '' && n >= 0 && notes.trim() !== '' && when !== ''

  const mutation = useMutation({
    mutationFn: () =>
      setOpening({ data: { on_hand_usd: n, as_of: localInputToIso(when), notes } }),
    onSuccess: (r) => {
      toast.success(
        r.adjusted_usd === '0.00'
          ? 'Stock already matches — nothing to adjust'
          : `Opening stock set — ${formatUsd(r.adjusted_usd)} marked as used before today`,
      )
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set opening stock</DialogTitle>
          <DialogDescription>
            Every purchase recorded so far counts as still in stock ({formatUsd(recordedUsd)}).
            Enter the USD actually in your wallets now — Binance, Payoneer and the
            rest together. The difference is marked as used, oldest purchases first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="opening-usd">USD on hand</Label>
              <Input
                id="opening-usd"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={onHand}
                onChange={(e) => setOnHand(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="opening-when">As of</Label>
              <Input
                id="opening-when"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="opening-notes">Evidence</Label>
            <Textarea
              id="opening-notes"
              rows={2}
              maxLength={500}
              placeholder="Binance 1,240.55 + Payoneer 310.00, screenshots saved 20 Oct"
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
            Set opening stock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Reason-required confirmation: reversing a record, reopening a month. */
export function ReverseDialog({
  target,
  onOpenChange,
  onConfirm,
  pending,
}: {
  target: { title: string; description: string; confirmLabel?: string } | null
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => void
  pending: boolean
}) {
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (target) setReason('')
  }, [target])
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target?.title}</DialogTitle>
          <DialogDescription>{target?.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reverse-reason">Reason</Label>
          <Textarea
            id="reverse-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim() === '' || pending}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            {target?.confirmLabel ?? 'Reverse'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
