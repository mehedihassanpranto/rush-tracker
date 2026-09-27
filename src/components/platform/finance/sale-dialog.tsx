import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  createUsdSaleFn,
  getAgencyUsdSummaryFn,
  getUsdStockSummaryFn,
  listAgencyAdAccountsFn,
} from '@/server/platform/finance.fns'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
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

// Radix Select cannot hold an empty-string value, so "no earmarked account"
// needs a real sentinel.
const NO_ACCOUNT = 'none'

/**
 * Records USD/limit the platform sold to an agency for BDT. The selling rate
 * is worked out from the two amounts. An earmarked ad account is optional —
 * an agency can stock up ahead of demand (spec §6, "not every usd_sale needs a
 * funding transaction behind it").
 */
export function RecordSaleDialog({
  open,
  onOpenChange,
  presetOrganizationId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Preselects the agency, e.g. when opened from that agency's history. */
  presetOrganizationId?: string
}) {
  const queryClient = useQueryClient()
  const listAgencies = useServerFn(getAgencyUsdSummaryFn)
  const listAccounts = useServerFn(listAgencyAdAccountsFn)
  const getSummary = useServerFn(getUsdStockSummaryFn)
  const createSale = useServerFn(createUsdSaleFn)

  const [organizationId, setOrganizationId] = useState('')
  const [accountId, setAccountId] = useState(NO_ACCOUNT)
  const [usd, setUsd] = useState('')
  const [bdt, setBdt] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) {
      setOrganizationId(presetOrganizationId ?? '')
      setAccountId(NO_ACCOUNT)
      setUsd('')
      setBdt('')
      setWhen(nowLocalInput())
      setNotes('')
    }
  }, [open, presetOrganizationId])

  const { data: agencies, isLoading: agenciesLoading } = useQuery({
    queryKey: ['platform-usd', 'agencies'],
    queryFn: () => listAgencies(),
    enabled: open,
  })
  const realAgencies = (agencies ?? []).filter(
    (a): a is typeof a & { organization_id: string } => !a.removed && a.organization_id !== null,
  )

  const { data: accounts } = useQuery({
    queryKey: ['platform-usd', 'agency-accounts', organizationId],
    queryFn: () => listAccounts({ data: { organization_id: organizationId } }),
    enabled: open && organizationId !== '',
  })

  const { data: summary } = useQuery({
    queryKey: ['platform-usd', 'summary'],
    queryFn: () => getSummary(),
    enabled: open,
  })

  const usdNum = Number(usd)
  const bdtNum = Number(bdt)
  const usdOk = usd !== '' && Number.isFinite(usdNum) && usdNum > 0
  const bdtOk = bdt !== '' && Number.isFinite(bdtNum) && bdtNum > 0
  const rate = usdOk && bdtOk ? dec(bdtNum).div(dec(usdNum)) : null
  const valid = organizationId !== '' && usdOk && bdtOk && when !== ''

  // What this sale would earn over the platform's average cost — a preview
  // only; the ledger's own summary is what actually reports it.
  const avgBuy = summary?.avg_buying_rate ?? null
  const preview =
    usdOk && bdtOk && avgBuy !== null
      ? dec(bdtNum).minus(dec(usdNum).mul(dec(avgBuy)))
      : null

  // Soft warning, not a block: a real sale can be recorded before the purchase
  // that covers it has been entered.
  const inStock = summary ? dec(summary.remaining_usd_stock) : null
  const exceedsStock = usdOk && inStock !== null && dec(usdNum).gt(inStock)

  const mutation = useMutation({
    mutationFn: () =>
      createSale({
        data: {
          organization_id: organizationId,
          ad_account_id: accountId === NO_ACCOUNT ? undefined : accountId,
          usd_amount: usdNum,
          bdt_amount: bdtNum,
          sold_at: localInputToIso(when),
          notes: notes || undefined,
        },
      }),
    onSuccess: (sale) => {
      toast.success(`Sale ${sale.reference_id} recorded`)
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record agency sale</DialogTitle>
          <DialogDescription>
            USD the platform sold to an agency and the BDT it received. The
            selling rate is worked out from the two.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sale-agency">Agency</Label>
            <Select
              value={organizationId}
              onValueChange={(v) => {
                setOrganizationId(v)
                setAccountId(NO_ACCOUNT)
              }}
            >
              <SelectTrigger id="sale-agency">
                <SelectValue placeholder={agenciesLoading ? 'Loading…' : 'Choose an agency'} />
              </SelectTrigger>
              <SelectContent>
                {realAgencies.map((a) => (
                  <SelectItem key={a.organization_id} value={a.organization_id}>
                    {a.name}
                    {a.subscription_status && a.subscription_status !== 'active'
                      ? ` (${a.subscription_status})`
                      : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sale-account">Earmarked ad account (optional)</Label>
            <Select
              value={accountId}
              onValueChange={setAccountId}
              disabled={organizationId === ''}
            >
              <SelectTrigger id="sale-account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ACCOUNT}>Not earmarked</SelectItem>
                {(accounts ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.account_code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sale-usd">USD sold</Label>
              <Input
                id="sale-usd"
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
              <Label htmlFor="sale-bdt">BDT received</Label>
              <Input
                id="sale-bdt"
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

          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              Selling rate:{' '}
              <span className="num font-medium text-foreground">
                {rate ? `৳${fmtRate(rate)}` : '—'}
              </span>{' '}
              per USD
            </p>
            {preview && (
              <p>
                At the average buying rate of{' '}
                <span className="num">৳{fmtRate(avgBuy)}</span> this earns{' '}
                <span
                  className={
                    preview.isNegative()
                      ? 'num font-medium text-danger'
                      : 'num font-medium text-success'
                  }
                >
                  {formatBdt(preview)}
                </span>
                .
              </p>
            )}
            {exceedsStock && inStock && (
              <p className="rounded-md bg-warning-bg px-3 py-2 text-foreground">
                That is more than the {formatUsd(inStock)} in stock. If a
                purchase is missing from the ledger, record it too — the sale
                is still allowed.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sale-when">Sold</Label>
            <Input
              id="sale-when"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sale-notes">Notes (optional)</Label>
            <Textarea
              id="sale-notes"
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
            Record sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
