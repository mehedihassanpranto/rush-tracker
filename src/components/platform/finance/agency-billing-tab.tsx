import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, Paperclip, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import { getAgencyStatementFn } from '@/server/platform/finance-close.fns'
import { downloadCsv } from '@/lib/csv/csv'
import {
  approveAgencyPaymentSubmissionFn,
  getAgencyPaymentProofUrlFn,
  listPendingAgencyPaymentsFn,
  rejectAgencyPaymentSubmissionFn,
  getEarliestPendingChargeFn,
  listAgencyBillingFn,
  listAgencyLedgerFn,
  listAgencyRatesFn,
  recordAgencyOpeningBalanceFn,
  recordAgencyPaymentFn,
  reverseAgencyChargeFn,
  reverseAgencyPaymentFn,
  setAgencyRateFn,
} from '@/server/platform/agency-billing.fns'
import Decimal from 'decimal.js'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime, fmtRate, localInputToIso, nowLocalInput } from '@/components/platform/finance/format'
import { ReverseDialog } from '@/components/platform/finance/inventory-dialogs'
import type { AgencyBillingRow, AgencyLedgerRow, AgencyPaymentSubmissionRow } from '@/server/platform/agency-billing.fns'
import { StatusBadge } from '@/components/shared/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

/** xRush Agency — the owner's own; its payments default to "internal". */
const ORG_ZERO = '00000000-0000-0000-0000-000000000001'
const dhakaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

/**
 * Finance v2 Milestone 4 (migration 000064): what each agency owes the
 * platform. Every limit approved on a pool account is charged at the agency's
 * rate automatically; payments settle it; anything paid beyond what is owed
 * is an advance the next charges use up. A payment is never revenue.
 */
export function AgencyBillingTab({ onRecordPayment }: { onRecordPayment: (orgId?: string) => void }) {
  const list = useServerFn(listAgencyBillingFn)
  const [rateFor, setRateFor] = useState<AgencyBillingRow | null>(null)
  const [openingFor, setOpeningFor] = useState<AgencyBillingRow | null>(null)
  const [viewing, setViewing] = useState<AgencyBillingRow | null>(null)

  const agencies = useQuery({ queryKey: ['platform-usd', 'agency-billing'], queryFn: () => list() })
  const rows = agencies.data ?? []
  const waiting = rows.filter((r) => r.pending_rate > 0)
  const total = (k: 'billed_bdt' | 'paid_bdt' | 'owed_bdt' | 'advance_bdt') =>
    rows.reduce((s, r) => s.plus(r[k]), dec(0)).toFixed(2)

  return (
    <>
      <PaymentsToReview />

      {waiting.length > 0 && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertTitle>Approvals waiting for a rate</AlertTitle>
          <AlertDescription>
            {waiting.map((r) => `${r.name}: ${r.pending_rate} (${formatUsd(r.pending_usd)})`).join(' · ')}. Set the
            agency's rate and they are billed straight away.
          </AlertDescription>
        </Alert>
      )}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Agencies</h2>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agency</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead className="text-right">Advance</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agencies.isLoading && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {!!agencies.error && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-destructive">
                    {agencies.error instanceof Error ? agencies.error.message : 'Could not load'}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.organization_id}>
                  <TableCell>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.organization_id === ORG_ZERO ? 'Your own agency' : r.subscription_status}
                      {r.pending_rate > 0 && <span className="ml-1 text-warning">· {r.pending_rate} waiting for a rate</span>}
                    </div>
                  </TableCell>
                  <TableCell className="num text-right">
                    {r.current_rate ? `৳${fmtRate(r.current_rate)}` : <span className="text-warning">Not set</span>}
                  </TableCell>
                  <TableCell className="num text-right">
                    {formatBdt(r.billed_bdt)}
                    <div className="text-xs text-muted-foreground">{formatUsd(r.billed_usd)}</div>
                  </TableCell>
                  <TableCell className="num text-right">{formatBdt(r.paid_bdt)}</TableCell>
                  <TableCell className={`num text-right font-medium ${dec(r.owed_bdt).gt(0) ? 'text-warning' : ''}`}>
                    {formatBdt(r.owed_bdt)}
                  </TableCell>
                  <TableCell className="num text-right">{dec(r.advance_bdt).gt(0) ? formatBdt(r.advance_bdt) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => onRecordPayment(r.organization_id)}>
                        Payment
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setRateFor(r)}>
                        Rate
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setViewing(r)}>
                        View
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length > 1 && (
                <TableRow className="font-medium hover:bg-transparent">
                  <TableCell>Total</TableCell>
                  <TableCell />
                  <TableCell className="num text-right">{formatBdt(total('billed_bdt'))}</TableCell>
                  <TableCell className="num text-right">{formatBdt(total('paid_bdt'))}</TableCell>
                  <TableCell className="num text-right">{formatBdt(total('owed_bdt'))}</TableCell>
                  <TableCell className="num text-right">{formatBdt(total('advance_bdt'))}</TableCell>
                  <TableCell />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
        <p className="mt-2 text-xs text-muted-foreground">
          Every limit approved on a pool account is billed at the agency's rate on the day it
          was approved (from go-live on 21 Oct 2026). Owed = billed − paid; a payment beyond
          what is owed becomes an advance that the next approvals use up. "View" shows an
          agency's charges and payments, and where to enter what it owed before go-live.
        </p>
      </div>

      <RateDialog agency={rateFor} onOpenChange={(o) => !o && setRateFor(null)} />
      <OpeningBalanceDialog agency={openingFor} onOpenChange={(o) => !o && setOpeningFor(null)} />
      <AgencyLedgerDialog
        agency={viewing}
        onOpenChange={(o) => !o && setViewing(null)}
        onOpeningBalance={() => {
          setOpeningFor(viewing)
          setViewing(null)
        }}
      />
    </>
  )
}

function RateDialog({ agency, onOpenChange }: { agency: AgencyBillingRow | null; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const setRate = useServerFn(setAgencyRateFn)
  const earliest = useServerFn(getEarliestPendingChargeFn)
  const listRates = useServerFn(listAgencyRatesFn)
  const [rate, setRateValue] = useState('')
  const [from, setFrom] = useState(dhakaToday())
  const [note, setNote] = useState('')

  const pending = useQuery({
    queryKey: ['platform-usd', 'earliest-pending', agency?.organization_id],
    queryFn: () => earliest({ data: { organization_id: agency!.organization_id } }),
    enabled: !!agency,
  })
  const history = useQuery({
    queryKey: ['platform-usd', 'agency-rates', agency?.organization_id],
    queryFn: () => listRates({ data: { organization_id: agency!.organization_id } }),
    enabled: !!agency,
  })
  useEffect(() => {
    if (agency) {
      setRateValue(agency.current_rate ?? '')
      setNote('')
      setFrom(dhakaToday())
    }
  }, [agency])
  // Start the rate early enough to price everything waiting.
  useEffect(() => {
    if (pending.data) {
      setFrom(new Date(pending.data).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }))
    }
  }, [pending.data])

  const valid = rate !== '' && Number(rate) > 0 && from !== ''
  const mutation = useMutation({
    mutationFn: () =>
      setRate({ data: { organization_id: agency!.organization_id, rate: Number(rate), effective_from: from, note: note || undefined } }),
    onSuccess: (r) => {
      toast.success(r.priced > 0 ? `Rate set — ${r.priced} waiting approval${r.priced === 1 ? '' : 's'} billed` : 'Rate set')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={!!agency} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>USD rate for {agency?.name}</DialogTitle>
          <DialogDescription>
            BDT per USD this agency pays for pool-account limits. A new rate applies to
            approvals from its start date; earlier charges keep the rate they were billed at.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="agency-rate">Rate (BDT per USD)</Label>
              <Input id="agency-rate" type="number" min="0" step="0.01" inputMode="decimal" value={rate} onChange={(e) => setRateValue(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agency-rate-from">Starts</Label>
              <Input id="agency-rate-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
          </div>
          {pending.data && (
            <p className="text-xs text-muted-foreground">
              Starts on the date of the oldest approval still waiting, so they are all billed.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="agency-rate-note">Note (optional)</Label>
            <Input id="agency-rate-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </div>
          {(history.data?.length ?? 0) > 0 && (
            <div className="text-xs text-muted-foreground">
              Earlier rates:{' '}
              {history.data!.map((h) => `৳${fmtRate(h.rate)} from ${h.effective_from}`).join(' · ')}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Set rate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Opened from the page header (choose the agency) or from a row (fixed). */
export function AgencyPaymentDialog({
  open,
  onOpenChange,
  presetOrganizationId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  presetOrganizationId?: string
}) {
  const queryClient = useQueryClient()
  const list = useServerFn(listAgencyBillingFn)
  const record = useServerFn(recordAgencyPaymentFn)
  const [orgId, setOrgId] = useState('')
  const [amount, setAmount] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [method, setMethod] = useState('')
  const [reference, setReference] = useState('')
  const [internal, setInternal] = useState(false)
  const [notes, setNotes] = useState('')
  const [key, setKey] = useState('')

  const agencies = useQuery({ queryKey: ['platform-usd', 'agency-billing'], queryFn: () => list(), enabled: open })
  useEffect(() => {
    if (open) {
      setOrgId(presetOrganizationId ?? '')
      setAmount('')
      setWhen(nowLocalInput())
      setMethod('')
      setReference('')
      setInternal(presetOrganizationId === ORG_ZERO)
      setNotes('')
      setKey(crypto.randomUUID())
    }
  }, [open, presetOrganizationId])

  const agency = agencies.data?.find((a) => a.organization_id === orgId)
  const n = Number(amount)
  const owed = agency ? dec(agency.owed_bdt) : dec(0)
  const applied = amount !== '' && n > 0 ? dec(Math.min(n, Math.max(owed.toNumber(), 0))) : null
  const advance = applied ? dec(n).minus(applied) : null
  const valid = orgId !== '' && amount !== '' && n > 0 && when !== ''

  const mutation = useMutation({
    mutationFn: () =>
      record({
        data: {
          organization_id: orgId,
          bdt_amount: n,
          received_at: localInputToIso(when),
          method: method || undefined,
          is_internal: internal,
          external_reference: reference || undefined,
          notes: notes || undefined,
          idempotency_key: key,
        },
      }),
    onSuccess: (r) => {
      toast.success(
        dec(r.advance_bdt).gt(0)
          ? `Payment recorded — ${formatBdt(r.applied_bdt)} settled, ${formatBdt(r.advance_bdt)} kept as advance`
          : 'Payment recorded',
      )
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record agency payment</DialogTitle>
          <DialogDescription>
            BDT an agency paid the platform. It settles what the agency owes; anything beyond
            that is kept as an advance for its next approvals. A payment is never revenue.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pay-agency">Agency</Label>
            <Select
              value={orgId}
              onValueChange={(v) => {
                setOrgId(v)
                setInternal(v === ORG_ZERO)
              }}
              disabled={!!presetOrganizationId}
            >
              <SelectTrigger id="pay-agency">
                <SelectValue placeholder={agencies.isLoading ? 'Loading…' : 'Choose an agency'} />
              </SelectTrigger>
              <SelectContent>
                {(agencies.data ?? []).map((a) => (
                  <SelectItem key={a.organization_id} value={a.organization_id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agency && (
              <p className="text-xs text-muted-foreground">
                Owes {formatBdt(agency.owed_bdt)}
                {dec(agency.advance_bdt).gt(0) && ` · advance ${formatBdt(agency.advance_bdt)}`}
              </p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pay-amount">BDT received</Label>
              <Input id="pay-amount" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-when">Received</Label>
              <Input id="pay-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </div>
          {applied && advance && advance.gt(0) && (
            <p className="text-sm">
              {formatBdt(applied)} settles what is owed; <span className="font-medium">{formatBdt(advance)}</span> is kept as an advance.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pay-method">Method (optional)</Label>
              <Input id="pay-method" value={method} maxLength={100} placeholder="DBBL transfer, bKash…" onChange={(e) => setMethod(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-ref">Reference (optional)</Label>
              <Input id="pay-ref" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={internal} onCheckedChange={(v) => setInternal(v === true)} />
            Internal transfer (between your own agency and the platform)
          </label>
          <div className="space-y-2">
            <Label htmlFor="pay-notes">Notes (optional)</Label>
            <Textarea id="pay-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OpeningBalanceDialog({ agency, onOpenChange }: { agency: AgencyBillingRow | null; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const record = useServerFn(recordAgencyOpeningBalanceFn)
  const [amount, setAmount] = useState('')
  const [credit, setCredit] = useState(false)
  const [when, setWhen] = useState(nowLocalInput())
  const [notes, setNotes] = useState('')
  useEffect(() => {
    if (agency) {
      setAmount('')
      setCredit(false)
      setWhen(nowLocalInput())
      setNotes('')
    }
  }, [agency])
  const n = Number(amount)
  const valid = amount !== '' && n > 0 && notes.trim() !== '' && when !== ''
  const mutation = useMutation({
    mutationFn: () =>
      record({
        data: { organization_id: agency!.organization_id, bdt_amount: credit ? -n : n, as_of: localInputToIso(when), notes },
      }),
    onSuccess: () => {
      toast.success('Opening balance recorded')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  return (
    <Dialog open={!!agency} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Opening balance — {agency?.name}</DialogTitle>
          <DialogDescription>
            What this agency owed you (or had paid ahead) before billing started on 21 Oct
            2026. Entered once; it doesn't count as this period's revenue.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="opening-bdt">BDT</Label>
              <Input id="opening-bdt" type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="opening-as-of">As of</Label>
              <Input id="opening-as-of" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={credit} onCheckedChange={(v) => setCredit(v === true)} />
            The agency had paid ahead (credit with you), not owed
          </label>
          <div className="space-y-2">
            <Label htmlFor="opening-notes-agency">Where the figure comes from</Label>
            <Textarea id="opening-notes-agency" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
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

const TYPE_LABEL: Record<AgencyLedgerRow['type'], string> = {
  CHARGE: 'Approval billed',
  OPENING_BALANCE: 'Opening balance',
  PAYMENT: 'Payment',
}

function AgencyLedgerDialog({
  agency,
  onOpenChange,
  onOpeningBalance,
}: {
  agency: AgencyBillingRow | null
  onOpenChange: (o: boolean) => void
  onOpeningBalance: () => void
}) {
  const queryClient = useQueryClient()
  const listLedger = useServerFn(listAgencyLedgerFn)
  const reverseCharge = useServerFn(reverseAgencyChargeFn)
  const reversePayment = useServerFn(reverseAgencyPaymentFn)
  const getStatement = useServerFn(getAgencyStatementFn)
  const [reversing, setReversing] = useState<AgencyLedgerRow | null>(null)
  // Client-safe: what was billed and paid, the agency's own rate, the running
  // balance — never cost, margin or supplier figures.
  const statement = useMutation({
    mutationFn: () => getStatement({ data: { organization_id: agency!.organization_id } }),
    onSuccess: (st) => {
      const slug = st.agency.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      downloadCsv(`statement-${slug}-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })}.csv`, st.rows, [
        { header: 'Date', value: (r) => new Date(r.date).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) },
        { header: 'Reference', value: (r) => r.reference },
        { header: 'Description', value: (r) => r.description },
        { header: 'USD', value: (r) => r.usd ?? '' },
        { header: 'Rate (BDT/USD)', value: (r) => r.rate ?? '' },
        { header: 'Billed (BDT)', value: (r) => r.billed_bdt ?? '' },
        { header: 'Paid (BDT)', value: (r) => r.paid_bdt ?? '' },
        { header: 'Balance (BDT)', value: (r) => r.balance_bdt },
      ])
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const ledger = useQuery({
    queryKey: ['platform-usd', 'agency-ledger', agency?.organization_id],
    queryFn: () => listLedger({ data: { organization_id: agency!.organization_id } }),
    enabled: !!agency,
  })
  const hasOpening = (ledger.data ?? []).some((r) => r.type === 'OPENING_BALANCE' && r.status !== 'REVERSED')
  const reverse = useMutation({
    mutationFn: (v: { row: AgencyLedgerRow; reason: string }) =>
      v.row.type === 'PAYMENT'
        ? reversePayment({ data: { id: v.row.id, reason: v.reason } })
        : reverseCharge({ data: { id: v.row.id, reason: v.reason } }),
    onSuccess: () => {
      toast.success('Reversed')
      setReversing(null)
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={!!agency} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{agency?.name}</DialogTitle>
          <DialogDescription>
            Owes {formatBdt(agency?.owed_bdt ?? '0')}
            {agency && dec(agency.advance_bdt).gt(0) && ` · advance ${formatBdt(agency.advance_bdt)}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button size="sm" variant="outline" disabled={statement.isPending} onClick={() => statement.mutate()}>
            {statement.isPending && <Loader2 className="size-4 animate-spin" />}
            Download statement (CSV)
          </Button>
        </div>
        {!ledger.isLoading && !hasOpening && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
            <span className="text-muted-foreground">Did this agency owe you anything before 21 Oct 2026?</span>
            <Button size="sm" variant="outline" onClick={onOpeningBalance}>
              Enter opening balance
            </Button>
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>What</TableHead>
              <TableHead className="text-right">BDT</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ledger.isLoading && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            )}
            {ledger.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  Nothing billed or paid yet.
                </TableCell>
              </TableRow>
            )}
            {ledger.data?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.at)}</TableCell>
                <TableCell className="whitespace-normal">
                  <span className="num mr-2">{r.reference_id}</span>
                  {TYPE_LABEL[r.type]}
                  <div className="text-xs text-muted-foreground">
                    {r.usd_amount && `${formatUsd(r.usd_amount)}${r.rate ? ` @ ৳${fmtRate(r.rate)}` : ''} · `}
                    {r.advance_bdt && dec(r.advance_bdt).gt(0) && `${formatBdt(r.advance_bdt)} kept as advance · `}
                    {r.detail}
                  </div>
                </TableCell>
                <TableCell className={`num text-right ${r.type === 'PAYMENT' ? 'text-success' : ''}`}>
                  {r.bdt_amount ? `${r.type === 'PAYMENT' ? '−' : ''}${formatBdt(r.bdt_amount)}` : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status === 'PENDING_RATE' ? 'PENDING' : r.status} />
                  {r.reversal_reason && <div className="mt-1 text-xs text-muted-foreground">{r.reversal_reason}</div>}
                </TableCell>
                <TableCell className="text-right">
                  {r.status !== 'REVERSED' && (
                    <Button size="sm" variant="outline" onClick={() => setReversing(r)}>
                      {r.status === 'PENDING_RATE' ? 'Cancel' : 'Reverse'}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ReverseDialog
          target={
            reversing
              ? {
                  title: `Reverse ${reversing.reference_id}`,
                  description:
                    reversing.type === 'PAYMENT'
                      ? 'The payment is undone and what it settled is owed again. The record stays, marked reversed.'
                      : 'The charge is undone; any advance it used is given back. The record stays, marked reversed.',
                }
              : null
          }
          onOpenChange={(o) => !o && setReversing(null)}
          onConfirm={(reason) => reversing && reverse.mutate({ row: reversing, reason })}
          pending={reverse.isPending}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * Payments agencies submitted with proof (migration 000066). Approving books
 * it like "Record agency payment" — it settles what is owed, the rest becomes
 * the agency's credit — dated when the agency paid. The agency's SUPER_ADMIN
 * is told the outcome either way.
 */
function PaymentsToReview() {
  const queryClient = useQueryClient()
  const list = useServerFn(listPendingAgencyPaymentsFn)
  const getProof = useServerFn(getAgencyPaymentProofUrlFn)
  const approve = useServerFn(approveAgencyPaymentSubmissionFn)
  const reject = useServerFn(rejectAgencyPaymentSubmissionFn)
  const [approving, setApproving] = useState<AgencyPaymentSubmissionRow | null>(null)
  const [rejecting, setRejecting] = useState<AgencyPaymentSubmissionRow | null>(null)
  const [amount, setAmount] = useState('')

  const pending = useQuery({ queryKey: ['platform-usd', 'agency-payments-pending'], queryFn: () => list() })
  useEffect(() => {
    if (approving) setAmount(approving.bdt_amount)
  }, [approving])
  const done = (msg: string) => {
    toast.success(msg)
    void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
  }
  const proof = useMutation({
    mutationFn: (id: string) => getProof({ data: { id } }),
    onSuccess: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const approveMut = useMutation({
    mutationFn: () => approve({ data: { id: approving!.id, bdt_amount: Number(amount) } }),
    onSuccess: (r) => {
      setApproving(null)
      done(dec(r.advance_bdt).gt(0) ? `Approved — ${formatBdt(r.advance_bdt)} kept as the agency's credit` : 'Approved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const rejectMut = useMutation({
    mutationFn: (reason: string) => reject({ data: { id: rejecting!.id, reason } }),
    onSuccess: () => {
      setRejecting(null)
      done('Rejected — the agency has been told why')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const rows = pending.data ?? []
  if (rows.length === 0) return null
  const n = Number(amount)
  const owedNow = approving ? dec(approving.owed_bdt) : dec(0)
  const extra = approving && amount !== '' && n > 0 ? dec(n).minus(Decimal.max(owedNow, 0)) : null

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">Payments to review ({rows.length})</h2>
      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agency</TableHead>
              <TableHead>Paid</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Owes now</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-normal">
                  <div className="font-medium">{r.agency_name}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="num">{r.reference_id}</span> · {[r.method, r.external_reference].filter(Boolean).join(' · ')}
                    {r.note && ` · ${r.note}`}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.paid_at)}</TableCell>
                <TableCell className="num text-right font-medium">{formatBdt(r.bdt_amount)}</TableCell>
                <TableCell className="num text-right text-muted-foreground">{formatBdt(r.owed_bdt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="ghost" disabled={!r.has_proof || proof.isPending} onClick={() => proof.mutate(r.id)}>
                      <Paperclip className="size-4" />
                      {r.has_proof ? 'Proof' : 'No proof'}
                    </Button>
                    <Button size="sm" onClick={() => setApproving(r)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRejecting(r)}>
                      Reject
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Check the proof against your bank or wallet before approving. If a different amount arrived, approve
        the amount that arrived.
      </p>

      <Dialog open={!!approving} onOpenChange={(o) => !o && setApproving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve {approving?.reference_id}</DialogTitle>
            <DialogDescription>
              {approving?.agency_name} says it paid {approving ? formatBdt(approving.bdt_amount) : ''} by {approving?.method}
              {approving ? ` on ${fmtDateTime(approving.paid_at)}` : ''}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="approve-amount">Amount that arrived (BDT)</Label>
            <Input id="approve-amount" type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            {extra && (
              <p className="text-sm text-muted-foreground">
                {extra.gt(0)
                  ? `${formatBdt(Decimal.max(owedNow, 0).toFixed(2))} settles what it owes; ${formatBdt(extra.toFixed(2))} becomes its credit.`
                  : 'All of it settles what the agency owes.'}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setApproving(null)}>
              Cancel
            </Button>
            <Button disabled={amount === '' || n <= 0 || approveMut.isPending} onClick={() => approveMut.mutate()}>
              {approveMut.isPending && <Loader2 className="size-4 animate-spin" />}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ReverseDialog
        target={
          rejecting
            ? {
                title: `Reject ${rejecting.reference_id}`,
                description: `${rejecting.agency_name}'s ${formatBdt(rejecting.bdt_amount)} payment. The agency's Super Admin sees your reason.`,
                confirmLabel: 'Reject',
              }
            : null
        }
        onOpenChange={(o) => !o && setRejecting(null)}
        onConfirm={(reason) => rejectMut.mutate(reason)}
        pending={rejectMut.isPending}
      />
    </div>
  )
}

