import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import {
  listMetaAccountPositionsFn,
  listMetaSpendEventsFn,
  listOpenMetaExceptionsFn,
  readPoolSpendNowFn,
  recordManualMetaSpendFn,
  resolveMetaExceptionFn,
  reverseMetaSpendFn,
  setMetaBillingModeFn,
} from '@/server/platform/meta-accounts.fns'
import {
  adjustPrepaidCreditFn,
  listPrepaidAdjustmentsFn,
  reversePrepaidAdjustmentFn,
} from '@/server/platform/finance-close.fns'
import type { PrepaidAdjustmentRow } from '@/server/platform/finance-close.fns'
import { META_BILLING_LABELS, META_BILLING_MODES } from '@/schemas/usd-inventory'
import { dec, formatBdt, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { fmtDateTime, localInputToIso, nowLocalInput } from '@/components/platform/finance/format'
import { OutflowDialog, ReverseDialog } from '@/components/platform/finance/inventory-dialogs'
import type {
  MetaAccountPosition,
  MetaSpendEventRow,
  MetaSpendExceptionRow,
} from '@/server/platform/meta-accounts.fns'
import type { MetaBillingMode } from '@/schemas/usd-inventory'
import { StatusBadge } from '@/components/shared/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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

const EXCEPTION_TEXT: Record<MetaSpendExceptionRow['kind'], (x: MetaSpendExceptionRow) => string> = {
  NEGATIVE_CHANGE: (x) =>
    `Meta's "amount spent" went DOWN by ${formatUsd(x.usd ?? '0')} (from ${formatUsd(String(x.details.from ?? 0))} to ${formatUsd(String(x.details.to ?? 0))}). Nothing was booked; tracking restarted from the new figure. If real spend was missed, enter it by hand.`,
  UNFUNDED_SPEND: (x) =>
    `${formatUsd(x.usd ?? '0')} of spend (${String(x.details.spend_event ?? '')}) was beyond the prepaid credit on this account. It is recorded but has no cost yet — fund the account, then decide.`,
  NON_USD: (x) =>
    `This account is billed in ${String(x.details.currency ?? 'another currency')}. Spend is only tracked for USD accounts.`,
}

const owedClass = (v: string) => (dec(v).gt(0) ? 'text-warning' : dec(v).lt(0) ? 'text-muted-foreground' : '')

/**
 * Finance v2 Milestone 3 (migration 000063): the platform pool's Meta
 * accounts. Funded, spent, prepaid left and owed to Meta are four separate
 * figures and never a spend cap. Postpaid spend costs nothing until Meta's
 * bill is paid (at FIFO cost); prepaid spend uses the account's own lots.
 */
export function MetaAccountsTab() {
  const queryClient = useQueryClient()
  const listPositions = useServerFn(listMetaAccountPositionsFn)
  const listEvents = useServerFn(listMetaSpendEventsFn)
  const listExceptions = useServerFn(listOpenMetaExceptionsFn)
  const readNow = useServerFn(readPoolSpendNowFn)
  const setMode = useServerFn(setMetaBillingModeFn)
  const reverseSpend = useServerFn(reverseMetaSpendFn)

  const [outflow, setOutflow] = useState<{ kind: 'META_BILL_PAYMENT' | 'META_PREPAID_FUNDING'; accountId: string } | null>(null)
  const [manualFor, setManualFor] = useState<MetaAccountPosition | null>(null)
  const [resolving, setResolving] = useState<MetaSpendExceptionRow | null>(null)
  const [reversing, setReversing] = useState<MetaSpendEventRow | null>(null)
  const [adjustFor, setAdjustFor] = useState<MetaAccountPosition | null>(null)
  const [undoAdjust, setUndoAdjust] = useState<PrepaidAdjustmentRow | null>(null)
  const listAdjustments = useServerFn(listPrepaidAdjustmentsFn)
  const reverseAdjustment = useServerFn(reversePrepaidAdjustmentFn)
  const adjustments = useQuery({ queryKey: ['platform-usd', 'prepaid-adjustments'], queryFn: () => listAdjustments() })
  const undoAdjustMut = useMutation({
    mutationFn: (v: { group_id: string; reason: string }) => reverseAdjustment({ data: v }),
    onSuccess: () => {
      toast.success('Reversed')
      setUndoAdjust(null)
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const positions = useQuery({ queryKey: ['platform-usd', 'meta-positions'], queryFn: () => listPositions() })
  const events = useQuery({ queryKey: ['platform-usd', 'meta-spend'], queryFn: () => listEvents() })
  const exceptions = useQuery({ queryKey: ['platform-usd', 'meta-exceptions'], queryFn: () => listExceptions() })
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })

  const read = useMutation({
    mutationFn: () => readNow(),
    onSuccess: (r) => {
      toast.success(
        `Read ${r.refreshed} account${r.refreshed === 1 ? '' : 's'} from Meta — ${r.posted} with new spend (${formatUsd(r.spend_usd)})` +
          (r.flagged ? `, ${r.flagged} flagged` : '') +
          (r.failed ? `, ${r.failed} could not be read` : ''),
      )
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const mode = useMutation({
    mutationFn: (v: { ad_account_id: string; mode: MetaBillingMode }) => setMode({ data: v }),
    onSuccess: (r) => {
      if (r.changed) toast.success('Billing mode changed')
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const reverse = useMutation({
    mutationFn: (v: { id: string; reason: string }) => reverseSpend({ data: v }),
    onSuccess: () => {
      toast.success('Spend reversed')
      setReversing(null)
      invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const rows = positions.data ?? []

  return (
    <>
      {(exceptions.data?.length ?? 0) > 0 && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertTitle>Spend to review ({exceptions.data!.length})</AlertTitle>
          <AlertDescription>
            <ul className="mt-2 space-y-3">
              {exceptions.data!.map((x) => (
                <li key={x.id} className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground">
                      {x.ad_account ? `${x.ad_account.account_code} · ${x.ad_account.name}` : 'Removed account'}
                      <span className="ml-2 text-xs text-muted-foreground">{fmtDateTime(x.event_at)}</span>
                    </div>
                    <p className="text-sm">{EXCEPTION_TEXT[x.kind](x)}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setResolving(x)}>
                    Resolve
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Pool accounts</h2>
          <Button size="sm" variant="outline" disabled={read.isPending} onClick={() => read.mutate()}>
            {read.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Read spend now
          </Button>
        </div>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Meta billing</TableHead>
                <TableHead className="text-right">Spent</TableHead>
                <TableHead className="text-right">Funded</TableHead>
                <TableHead className="text-right">Prepaid left</TableHead>
                <TableHead className="text-right">Paid to Meta</TableHead>
                <TableHead className="text-right">Owed to Meta</TableHead>
                <TableHead className="text-right">Meta's balance</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.isLoading && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {!!positions.error && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-sm text-destructive">
                    {positions.error instanceof Error ? positions.error.message : 'Could not load'}
                  </TableCell>
                </TableRow>
              )}
              {!positions.isLoading && !positions.error && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                    No platform pool accounts yet.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((a) => {
                const prepaid = a.meta_billing_mode === 'META_PREPAID'
                return (
                  <TableRow key={a.ad_account_id}>
                    <TableCell>
                      <div className="font-medium">
                        <span className="num mr-2 text-muted-foreground">{a.account_code}</span>
                        {a.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {a.tracking_since ? `Tracked since ${fmtDateTime(a.tracking_since)}` : 'Not read from Meta yet'}
                        {a.open_exceptions > 0 && <span className="ml-1 text-warning">· {a.open_exceptions} to review</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={a.meta_billing_mode}
                        disabled={mode.isPending}
                        onValueChange={(v) => mode.mutate({ ad_account_id: a.ad_account_id, mode: v as MetaBillingMode })}
                      >
                        <SelectTrigger className="h-8 w-28" aria-label={`Meta billing for ${a.account_code}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {META_BILLING_MODES.map((m) => (
                            <SelectItem key={m} value={m}>
                              {META_BILLING_LABELS[m]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="num text-right">{formatUsd(a.spent_usd)}</TableCell>
                    <TableCell className="num text-right">{prepaid || dec(a.funded_usd).gt(0) ? formatUsd(a.funded_usd) : '—'}</TableCell>
                    <TableCell className="num text-right">
                      {prepaid || dec(a.prepaid_left_usd).gt(0) ? (
                        <>
                          {formatUsd(a.prepaid_left_usd)}
                          <div className="text-xs text-muted-foreground">{formatBdt(a.prepaid_left_bdt)} at cost</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="num text-right">{formatUsd(a.paid_usd)}</TableCell>
                    <TableCell className={`num text-right font-medium ${owedClass(a.owed_usd)}`}>
                      {formatUsd(a.owed_usd)}
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {formatCurrencyAmount(a.meta_balance, a.meta_currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {prepaid ? (
                          <Button size="sm" variant="outline" onClick={() => setOutflow({ kind: 'META_PREPAID_FUNDING', accountId: a.ad_account_id })}>
                            Fund
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => setOutflow({ kind: 'META_BILL_PAYMENT', accountId: a.ad_account_id })}>
                            Pay bill
                          </Button>
                        )}
                        {dec(a.prepaid_left_usd).gt(0) && (
                          <Button size="sm" variant="outline" onClick={() => setAdjustFor(a)}>
                            Return / write off
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setManualFor(a)}>
                          Add spend
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>
        <p className="mt-2 text-xs text-muted-foreground">
          Spent is read from Meta once a day (and on "Read spend now"); spend from before
          tracking began is not counted. Owed to Meta = postpaid spend − bills paid — it costs
          nothing in the books until the bill is paid, at FIFO cost. Meta's balance is Meta's
          own figure, shown for comparison.
        </p>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Spend</h2>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">USD</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No spend tracked yet.
                  </TableCell>
                </TableRow>
              )}
              {events.data?.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(e.event_at)}</TableCell>
                  <TableCell className="num">
                    {e.reference_id}
                    <div className="text-xs text-muted-foreground">{e.source === 'SYNC' ? 'From Meta' : 'Entered by hand'}</div>
                  </TableCell>
                  <TableCell>
                    {e.ad_account ? `${e.ad_account.account_code} · ${e.ad_account.name}` : '—'}
                    <div className="text-xs text-muted-foreground">
                      {META_BILLING_LABELS[e.billing_mode]}
                      {e.notes && ` · ${e.notes}`}
                    </div>
                  </TableCell>
                  <TableCell className="num text-right">
                    {formatUsd(e.usd_amount)}
                    {dec(e.unfunded_usd).gt(0) && (
                      <div className="text-xs text-warning">{formatUsd(e.unfunded_usd)} unfunded</div>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">
                    {e.billing_mode === 'META_PREPAID' ? formatBdt(e.bdt_cost) : <span className="text-xs text-muted-foreground">at bill payment</span>}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={e.status} />
                    {e.reversal_reason && (
                      <div className="mt-1 max-w-[12rem] text-xs whitespace-normal text-muted-foreground">{e.reversal_reason}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {e.status === 'POSTED' && (
                      <Button size="sm" variant="outline" onClick={() => setReversing(e)}>
                        Reverse
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      {(adjustments.data?.length ?? 0) > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold">Prepaid credit returned or written off</h2>
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">USD</TableHead>
                  <TableHead className="text-right">At cost</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {adjustments.data!.map((x) => (
                  <TableRow key={x.group_id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(x.event_at)}</TableCell>
                    <TableCell className="num">
                      {x.reference_id}
                      <div className="text-xs text-muted-foreground">{x.kind === 'RETURN' ? 'Returned to stock' : 'Written off'}</div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {x.ad_account ? `${x.ad_account.account_code} · ${x.ad_account.name}` : '—'}
                      <div className="text-xs text-muted-foreground">{x.reason}</div>
                    </TableCell>
                    <TableCell className="num text-right">{formatUsd(x.usd)}</TableCell>
                    <TableCell className="num text-right">{formatBdt(x.bdt)}</TableCell>
                    <TableCell>
                      <StatusBadge status={x.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      {x.status === 'POSTED' && (
                        <Button size="sm" variant="outline" onClick={() => setUndoAdjust(x)}>
                          Reverse
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

      <AdjustPrepaidDialog account={adjustFor} onOpenChange={(o) => !o && setAdjustFor(null)} />
      <ReverseDialog
        target={
          undoAdjust
            ? {
                title: `Reverse ${undoAdjust.reference_id}`,
                description: `${formatUsd(undoAdjust.usd)} goes back onto the account as prepaid credit${undoAdjust.kind === 'RETURN' ? ', and out of stock again' : ''}.`,
              }
            : null
        }
        onOpenChange={(o) => !o && setUndoAdjust(null)}
        onConfirm={(reason) => undoAdjust && undoAdjustMut.mutate({ group_id: undoAdjust.group_id, reason })}
        pending={undoAdjustMut.isPending}
      />
      <OutflowDialog open={!!outflow} onOpenChange={(o) => !o && setOutflow(null)} preset={outflow} />
      <ManualSpendDialog account={manualFor} onOpenChange={(o) => !o && setManualFor(null)} />
      <ResolveDialog exception={resolving} onOpenChange={(o) => !o && setResolving(null)} />
      <ReverseDialog
        target={
          reversing
            ? {
                title: `Reverse ${reversing.reference_id}`,
                description: `${formatUsd(reversing.usd_amount)} of spend is undone${reversing.billing_mode === 'META_PREPAID' ? ' and goes back into the prepaid credit it used' : ''}. The record stays, marked reversed.`,
              }
            : null
        }
        onOpenChange={(o) => !o && setReversing(null)}
        onConfirm={(reason) => reversing && reverse.mutate({ id: reversing.id, reason })}
        pending={reverse.isPending}
      />
    </>
  )
}

function ManualSpendDialog({
  account,
  onOpenChange,
}: {
  account: MetaAccountPosition | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const record = useServerFn(recordManualMetaSpendFn)
  const [usd, setUsd] = useState('')
  const [when, setWhen] = useState(nowLocalInput())
  const [notes, setNotes] = useState('')
  const [key, setKey] = useState('')

  useEffect(() => {
    if (account) {
      setUsd('')
      setWhen(nowLocalInput())
      setNotes('')
      setKey(crypto.randomUUID())
    }
  }, [account])

  const valid = usd !== '' && Number(usd) > 0 && notes.trim() !== '' && when !== ''
  const mutation = useMutation({
    mutationFn: () =>
      record({
        data: {
          ad_account_id: account!.ad_account_id,
          usd_amount: Number(usd),
          event_at: localInputToIso(when),
          notes,
          idempotency_key: key,
        },
      }),
    onSuccess: () => {
      toast.success('Spend recorded')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add spend by hand</DialogTitle>
          <DialogDescription>
            {account ? `${account.account_code} · ${account.name}. ` : ''}For spend the daily
            reading missed — e.g. after Meta's figure went down.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="manual-spend-usd">USD spent</Label>
              <Input id="manual-spend-usd" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" value={usd} onChange={(e) => setUsd(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-spend-when">When</Label>
              <Input id="manual-spend-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="manual-spend-notes">Why</Label>
            <Textarea id="manual-spend-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Record spend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResolveDialog({
  exception,
  onOpenChange,
}: {
  exception: MetaSpendExceptionRow | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const resolve = useServerFn(resolveMetaExceptionFn)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (exception) setNote('')
  }, [exception])
  const mutation = useMutation({
    mutationFn: () => resolve({ data: { id: exception!.id, note } }),
    onSuccess: () => {
      toast.success('Marked resolved')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  return (
    <Dialog open={!!exception} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve</DialogTitle>
          <DialogDescription>{exception ? EXCEPTION_TEXT[exception.kind](exception) : ''}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="resolve-note">What was done</Label>
          <Textarea id="resolve-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={note.trim() === '' || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Mark resolved
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Unspent prepaid credit leaving an account (policy §4.5): back into stock at
 * the lot's original cost, or written off as an expense. A reason is required
 * either way.
 */
function AdjustPrepaidDialog({
  account,
  onOpenChange,
}: {
  account: MetaAccountPosition | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const adjust = useServerFn(adjustPrepaidCreditFn)
  const [kind, setKind] = useState<'RETURN' | 'WRITE_OFF'>('RETURN')
  const [usd, setUsd] = useState('')
  const [why, setWhy] = useState('')
  useEffect(() => {
    if (account) {
      setKind('RETURN')
      setUsd(account.prepaid_left_usd)
      setWhy('')
    }
  }, [account])
  const n = Number(usd)
  const valid = !!account && usd !== '' && n > 0 && dec(n).lte(account.prepaid_left_usd) && why.trim() !== ''
  const mutation = useMutation({
    mutationFn: () => adjust({ data: { ad_account_id: account!.ad_account_id, kind, usd: n, reason: why } }),
    onSuccess: (r) => {
      toast.success(`${r.reference_id}: ${kind === 'RETURN' ? 'returned to stock' : 'written off'} at ${formatBdt(r.bdt)}`)
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unspent prepaid credit</DialogTitle>
          <DialogDescription>
            {account ? `${account.account_code} · ${account.name}: ${formatUsd(account.prepaid_left_usd)} left (${formatBdt(account.prepaid_left_bdt)} at cost).` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="adjust-kind">What happened to it</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger id="adjust-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="RETURN">Back in our wallets — return to stock</SelectItem>
                <SelectItem value="WRITE_OFF">Lost — write it off</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjust-usd">USD</Label>
            <Input id="adjust-usd" type="number" min="0" step="0.01" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adjust-why">Why</Label>
            <Textarea id="adjust-why" rows={2} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            {kind === 'RETURN'
              ? 'It becomes a new batch in stock at the cost it was loaded at, oldest credit first.'
              : 'It becomes an expense ("Prepaid credit written off") at the cost it was loaded at.'}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {kind === 'RETURN' ? 'Return to stock' : 'Write off'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

