import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import { listUsdSourcesFn } from '@/server/platform/finance.fns'
import { postUsdPurchaseFn, previewUsdPurchaseFn } from '@/server/platform/usd-inventory.fns'
import { BANK_INSTITUTIONS, PAID_IN_CASH, bankName } from '@/schemas/usd-inventory'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { fmtRate, localInputToIso, nowLocalInput } from '@/components/platform/finance/format'
import type { ManualFeeInput, UsdPurchaseDraft } from '@/schemas/usd-inventory'
import { Alert, AlertDescription } from '@/components/ui/alert'
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

/** The bank the platform pays from unless told otherwise (owner, 2026-10-20). */
const DEFAULT_PAID_FROM = 'DBBL'

interface FeeEntry {
  open: boolean
  total: string
  yourShare: string
  reason: string
}
const EMPTY_FEE: FeeEntry = { open: false, total: '', yourShare: '', reason: '' }

function toManual(f: FeeEntry): ManualFeeInput | undefined {
  if (!f.open || f.total === '' || f.reason.trim() === '') return undefined
  const total = Number(f.total)
  const yours = f.yourShare === '' ? 0 : Number(f.yourShare)
  if (!Number.isFinite(total) || !Number.isFinite(yours)) return undefined
  return { total, your_share: yours, reason: f.reason.trim() }
}

/** Waits until typing settles, so the preview isn't re-run per keystroke. */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

/**
 * Records USD the platform bought as a FIFO batch (Finance v2). The server
 * works out the transfer fees from the fee rules and the supplier's bank, and
 * this dialog shows the result before anything is posted: net USD received,
 * the fees added to the batch's cost, and the effective rate FIFO will use. A
 * fee with no rule (Payoneer, an unusual route) must be entered here — it is
 * never assumed to be zero.
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
  const preview = useServerFn(previewUsdPurchaseFn)
  const post = useServerFn(postUsdPurchaseFn)

  const [sourceId, setSourceId] = useState('')
  const [paidFrom, setPaidFrom] = useState<string>(DEFAULT_PAID_FROM)
  const [gross, setGross] = useState('')
  const [bdt, setBdt] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [bankFee, setBankFee] = useState<FeeEntry>(EMPTY_FEE)
  const [usdFee, setUsdFee] = useState<FeeEntry>(EMPTY_FEE)

  useEffect(() => {
    if (open) {
      setSourceId('')
      setPaidFrom(DEFAULT_PAID_FROM)
      setGross('')
      setBdt('')
      setWhen(nowLocalInput())
      setReference('')
      setNotes('')
      setBankFee(EMPTY_FEE)
      setUsdFee(EMPTY_FEE)
    }
  }, [open])

  const { data: sources, isLoading } = useQuery({
    queryKey: ['platform-usd', 'sources'],
    queryFn: () => listSources(),
    enabled: open,
  })
  const active = (sources ?? []).filter((s) => s.is_active)

  const grossNum = Number(gross)
  const bdtNum = Number(bdt)
  const draft: UsdPurchaseDraft | null =
    sourceId && gross !== '' && grossNum > 0 && bdt !== '' && bdtNum > 0 && when
      ? {
          source_id: sourceId,
          paid_from: paidFrom as UsdPurchaseDraft['paid_from'],
          gross_usd: grossNum,
          bdt_principal: bdtNum,
          purchased_at: localInputToIso(when),
          bank_fee: toManual(bankFee),
          usd_fee: toManual(usdFee),
        }
      : null
  const settled = useSettled(draft)

  const check = useQuery({
    queryKey: ['platform-usd', 'purchase-preview', settled],
    queryFn: () => preview({ data: settled! }),
    enabled: open && !!settled,
    retry: false,
  })
  const p = check.data
  const current = JSON.stringify(draft) === JSON.stringify(settled)
  const ready = !!draft && current && !!p?.cost && !check.isFetching

  const mutation = useMutation({
    mutationFn: () =>
      post({
        data: {
          ...draft!,
          method: paidFrom === PAID_IN_CASH ? 'Cash' : bankName(paidFrom),
          external_reference: reference || undefined,
          notes: notes || undefined,
        },
      }),
    onSuccess: (r) => {
      if (r.duplicate) toast.info('That transfer reference is already recorded — nothing new was posted')
      else toast.success('USD purchase recorded')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const missingFor = (leg: 'BANK' | 'USD') => p?.missing.find((m) => m.leg === leg)
  const ruleFor = (leg: 'BANK' | 'USD') => p?.fees.find((f) => f.leg === leg)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add USD purchase</DialogTitle>
          <DialogDescription>
            Dollars bought from a supplier. Transfer fees are worked out from the
            fee rules; the ones you bear are added to this batch's cost.
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="purchase-usd">USD sent</Label>
              <Input
                id="purchase-usd"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={gross}
                onChange={(e) => setGross(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="purchase-bdt">BDT paid to supplier</Label>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="purchase-paid-from">Paid from</Label>
              <Select value={paidFrom} onValueChange={setPaidFrom}>
                <SelectTrigger id="purchase-paid-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BANK_INSTITUTIONS.map((b) => (
                    <SelectItem key={b.code} value={b.code}>
                      {b.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={PAID_IN_CASH}>Cash</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="purchase-when">Purchased</Label>
              <Input
                id="purchase-when"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>
          </div>

          {draft && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between text-sm font-medium">
                Fees
                {check.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              </div>
              {!!check.error && (
                <p className="text-sm text-destructive">
                  {check.error instanceof Error ? check.error.message : 'Could not work out the fees'}
                </p>
              )}
              {(['BANK', 'USD'] as const).map((leg) => {
                if (leg === 'BANK' && paidFrom === PAID_IN_CASH) return null
                const fee = ruleFor(leg)
                const missing = missingFor(leg)
                const entry = leg === 'BANK' ? bankFee : usdFee
                const setEntry = leg === 'BANK' ? setBankFee : setUsdFee
                const currency = leg === 'BANK' ? 'BDT' : 'USD'
                const fmt = (v: string) => (currency === 'BDT' ? formatBdt(v) : formatUsd(v))
                return (
                  <FeeLeg
                    key={leg}
                    title={leg === 'BANK' ? 'Bank transfer' : 'USD transfer'}
                    currency={currency}
                    line={
                      fee
                        ? {
                            label: fee.label,
                            total: fmt(fee.total),
                            yours: fmt(fee.your_share),
                            source: fee.source === 'MANUAL' ? 'entered' : fee.reason ? 'override' : 'rule',
                          }
                        : null
                    }
                    missing={missing?.message ?? null}
                    entry={entry}
                    onChange={setEntry}
                  />
                )
              })}
            </div>
          )}

          {p?.cost && current && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/50 p-3 text-sm">
              <dt className="text-muted-foreground">Net USD received</dt>
              <dd className="num text-right font-medium">{formatUsd(p.cost.net_usd)}</dd>
              <dt className="text-muted-foreground">Supplier rate</dt>
              <dd className="num text-right">৳{fmtRate(p.cost.supplier_rate)}</dd>
              <dt className="text-muted-foreground">Fees added to cost</dt>
              <dd className="num text-right">{formatBdt(p.cost.capitalized_fees_bdt)}</dd>
              <dt className="text-muted-foreground">Batch cost</dt>
              <dd className="num text-right font-medium">{formatBdt(p.cost.total_bdt_cost)}</dd>
              <dt className="text-muted-foreground">Effective rate</dt>
              <dd className="num text-right font-medium">৳{fmtRate(p.cost.effective_rate)}</dd>
            </dl>
          )}
          {p?.cost?.rate_warning && current && (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertDescription>
                The supplier rate is outside ৳124–131. Check the amounts — you can still record it.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="purchase-reference">Transfer reference (optional)</Label>
            <Input
              id="purchase-reference"
              value={reference}
              maxLength={120}
              placeholder="Binance / Payoneer transaction id"
              autoComplete="off"
              onChange={(e) => setReference(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The same reference from the same source is never recorded twice.
            </p>
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
          <Button disabled={!ready || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Record purchase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FeeLeg({
  title,
  currency,
  line,
  missing,
  entry,
  onChange,
}: {
  title: string
  currency: 'BDT' | 'USD'
  line: { label: string; total: string; yours: string; source: string } | null
  missing: string | null
  entry: FeeEntry
  onChange: (f: FeeEntry) => void
}) {
  const id = title.toLowerCase().replace(/\s+/g, '-')
  const showInputs = entry.open || (!!missing && !line)
  return (
    <div className="space-y-2 text-sm">
      {line ? (
        <div className="flex items-start justify-between gap-3">
          <div>
            <div>{line.label}</div>
            <div className="text-xs text-muted-foreground">
              {line.source === 'rule' ? 'From fee rule' : line.source === 'override' ? 'Rule overridden' : 'Entered by hand'}
            </div>
          </div>
          <div className="text-right">
            <div className="num">{line.total}</div>
            <div className="num text-xs text-muted-foreground">you bear {line.yours}</div>
          </div>
        </div>
      ) : (
        missing && <p className="text-warning">{missing}</p>
      )}

      {showInputs ? (
        <div className="grid gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-total`} className="text-xs">
              {title} fee ({currency})
            </Label>
            <Input
              id={`${id}-total`}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={entry.total}
              onChange={(e) => onChange({ ...entry, open: true, total: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-yours`} className="text-xs">
              Your share ({currency})
            </Label>
            <Input
              id={`${id}-yours`}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder="0"
              value={entry.yourShare}
              onChange={(e) => onChange({ ...entry, open: true, yourShare: e.target.value })}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`${id}-reason`} className="text-xs">
              Reason
            </Label>
            <Input
              id={`${id}-reason`}
              value={entry.reason}
              maxLength={500}
              placeholder={currency === 'USD' ? 'Payoneer statement' : 'Bank waived the fee'}
              onChange={(e) => onChange({ ...entry, open: true, reason: e.target.value })}
            />
          </div>
          {line && line.source !== 'entered' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="sm:col-span-2"
              onClick={() => onChange(EMPTY_FEE)}
            >
              Use the rule's fee
            </Button>
          )}
        </div>
      ) : (
        line &&
        line.source === 'rule' && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-2"
            onClick={() => onChange({ ...entry, open: true })}
          >
            Override this fee
          </button>
        )
      )}
    </div>
  )
}
