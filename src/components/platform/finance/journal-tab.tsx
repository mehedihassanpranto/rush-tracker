import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { CircleCheck, Lock, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import { getTrialBalanceFn, listJournalEntriesFn } from '@/server/platform/journal.fns'
import {
  closeFinancePeriodFn,
  listFinancePeriodsFn,
  reopenFinancePeriodFn,
} from '@/server/platform/agency-billing.fns'
import { ReverseDialog } from '@/components/platform/finance/inventory-dialogs'
import type { FinancePeriodRow } from '@/server/platform/agency-billing.fns'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime } from '@/components/platform/finance/format'
import type { TrialBalanceRow } from '@/server/platform/journal.fns'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const TYPE_LABELS: Record<TrialBalanceRow['type'], string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  EXPENSE: 'Expenses',
}
const TYPE_ORDER: Array<TrialBalanceRow['type']> = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']

const SOURCE_LABELS: Record<string, string> = {
  USD_PURCHASE: 'Purchase',
  USD_OUTFLOW: 'USD paid out',
  USD_SALE: 'Agency sale',
  USD_SALE_RECEIPT: 'BDT received',
  META_SPEND: 'Prepaid Meta spend',
  AGENCY_CHARGE: 'Agency billed',
  AGENCY_ADVANCE_APPLIED: 'Advance applied',
  AGENCY_PAYMENT: 'Agency payment',
  MANUAL: 'Manual',
}

/** Today in Asia/Dhaka as YYYY-MM-DD — the business day, as elsewhere. */
const dhakaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
/** End of a Dhaka business day (UTC+6, no DST) as an instant. */
const endOfDhakaDay = (day: string) => new Date(`${day}T23:59:59.999+06:00`).toISOString()

const amount = (v: string) => (v === '0.00' ? '' : formatBdt(v))

/**
 * Finance v2 double-entry journal (migration 000061). Every purchase, USD
 * payout and agency sale is posted here by the database itself, in taka, with
 * the dollars as a memo. Read-only: a mistake is corrected by reversing the
 * purchase or payout, which posts a mirror entry.
 */
export function JournalTab() {
  const getTb = useServerFn(getTrialBalanceFn)
  const listEntries = useServerFn(listJournalEntriesFn)
  const [day, setDay] = useState(dhakaToday())

  const tb = useQuery({
    queryKey: ['platform-usd', 'trial-balance', day],
    queryFn: () => getTb({ data: { as_of: endOfDhakaDay(day) } }),
    enabled: day !== '',
  })
  const entries = useQuery({
    queryKey: ['platform-usd', 'journal'],
    queryFn: () => listEntries({ data: { limit: 100 } }),
  })

  const t = tb.data
  const balanced = t && t.total_debit === t.total_credit
  const rows = (t?.rows ?? []).filter((r) => r.debit_bdt !== '0.00' || r.credit_bdt !== '0.00')

  return (
    <>
      {t && (
        <Alert variant={t.tie_out.ties ? 'default' : 'destructive'}>
          {t.tie_out.ties ? <CircleCheck className="size-4" /> : <TriangleAlert className="size-4" />}
          <AlertTitle>
            {t.tie_out.ties ? 'The books agree with the USD stock' : 'The books and the USD stock disagree'}
          </AlertTitle>
          <AlertDescription>
            USD inventory in the journal: {formatUsd(t.tie_out.books_usd)} at{' '}
            {formatBdt(t.tie_out.books_bdt)}. FIFO stock: {formatUsd(t.tie_out.fifo_usd)} at{' '}
            {formatBdt(t.tie_out.fifo_bdt)}.
          </AlertDescription>
        </Alert>
      )}

      <PeriodsCard />

      <div>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold">Trial balance</h2>
          <div className="space-y-1">
            <Label htmlFor="tb-as-of" className="text-xs text-muted-foreground">
              As of the end of
            </Label>
            <Input
              id="tb-as-of"
              type="date"
              className="w-44"
              value={day}
              max={dhakaToday()}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
        </div>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debits</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">USD</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tb.isLoading && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {!!tb.error && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-destructive">
                    {tb.error instanceof Error ? tb.error.message : 'Could not load'}
                  </TableCell>
                </TableRow>
              )}
              {t && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    Nothing posted by this date.
                  </TableCell>
                </TableRow>
              )}
              {TYPE_ORDER.map((type) => {
                const group = rows.filter((r) => r.type === type)
                if (group.length === 0) return null
                return (
                  <Fragment key={type}>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={5} className="py-1.5 text-xs font-medium text-muted-foreground">
                        {TYPE_LABELS[type]}
                      </TableCell>
                    </TableRow>
                    {group.map((r) => (
                      <TableRow key={r.code}>
                        <TableCell>
                          <span className="num mr-2 text-muted-foreground">{r.code}</span>
                          {r.name}
                        </TableCell>
                        <TableCell className="num text-right">{amount(r.debit_bdt)}</TableCell>
                        <TableCell className="num text-right">{amount(r.credit_bdt)}</TableCell>
                        <TableCell className="num text-right font-medium">{formatBdt(r.balance_bdt)}</TableCell>
                        <TableCell className="num text-right text-muted-foreground">
                          {r.usd == null ? '' : formatUsd(r.usd)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                )
              })}
            </TableBody>
            {t && (
              <TableFooter>
                <TableRow>
                  <TableCell className="font-medium">
                    Total{' '}
                    <span className={balanced ? 'text-success' : 'text-danger'}>
                      {balanced ? '· balanced' : '· NOT balanced'}
                    </span>
                  </TableCell>
                  <TableCell className="num text-right font-medium">{formatBdt(t.total_debit)}</TableCell>
                  <TableCell className="num text-right font-medium">{formatBdt(t.total_credit)}</TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </Card>
        <p className="mt-2 text-xs text-muted-foreground">
          Balances are shown positive on each account's normal side. Taka and dollars are
          never added together: USD is a memo on the accounts that move dollars.
        </p>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Journal entries</h2>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">USD</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.isLoading && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {!!entries.error && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-destructive">
                    {entries.error instanceof Error ? entries.error.message : 'Could not load'}
                  </TableCell>
                </TableRow>
              )}
              {entries.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    Nothing posted yet.
                  </TableCell>
                </TableRow>
              )}
              {entries.data?.map((e) => (
                <Fragment key={e.id}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={5} className="py-2 whitespace-normal">
                      <span className="num font-medium">{e.entry_number}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {fmtDateTime(e.event_at)} · {SOURCE_LABELS[e.source_type] ?? e.source_type}
                        {e.is_reversal && ' · reversal'}
                      </span>
                      <div className="text-sm">{e.description}</div>
                    </TableCell>
                  </TableRow>
                  {e.lines.map((l) => (
                    <TableRow key={l.line_no}>
                      <TableCell />
                      <TableCell className={l.credit_bdt !== '0.00' ? 'pl-8' : undefined}>
                        <span className="num mr-2 text-muted-foreground">{l.account_code}</span>
                        {l.account_name}
                        {l.memo && <div className="text-xs text-muted-foreground">{l.memo}</div>}
                      </TableCell>
                      <TableCell className="num text-right">{amount(l.debit_bdt)}</TableCell>
                      <TableCell className="num text-right">{amount(l.credit_bdt)}</TableCell>
                      <TableCell className="num text-right text-muted-foreground">
                        {l.usd_amount == null ? '' : formatUsd(l.usd_amount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
        <p className="mt-2 text-xs text-muted-foreground">
          The 100 most recently posted entries. Entries can't be edited or deleted;
          reversing a purchase or a payout posts its mirror.
        </p>
      </div>
    </>
  )
}

const monthLabel = (m: string) =>
  new Date(`${m}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/**
 * Month close (migration 000064). A closed month takes no postings: anything
 * dated in it is refused, corrections go into the open month. Only a month
 * that has ended can be closed, and not while approvals in it wait for a
 * rate. Reopening needs a reason and is audited.
 */
function PeriodsCard() {
  const queryClient = useQueryClient()
  const list = useServerFn(listFinancePeriodsFn)
  const close = useServerFn(closeFinancePeriodFn)
  const reopen = useServerFn(reopenFinancePeriodFn)
  const [reopening, setReopening] = useState<FinancePeriodRow | null>(null)
  const periods = useQuery({ queryKey: ['platform-usd', 'periods'], queryFn: () => list() })
  const current = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }).slice(0, 7) + '-01'

  const done = (msg: string) => {
    toast.success(msg)
    void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
  }
  const closing = useMutation({
    mutationFn: (month: string) => close({ data: { month } }),
    onSuccess: () => done('Month closed'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const reopenMut = useMutation({
    mutationFn: (v: { month: string; reason: string }) => reopen({ data: v }),
    onSuccess: () => {
      setReopening(null)
      done('Month reopened')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  // The current month and the three before it: enough to close last month.
  const rows = (periods.data ?? []).slice(0, 4)
  return (
    <div>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <Lock className="size-4" /> Months
      </h2>
      <Card className="p-0">
        <Table>
          <TableBody>
            {periods.isLoading && (
              <TableRow>
                <TableCell colSpan={3}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            )}
            {rows.map((p) => (
              <TableRow key={p.month}>
                <TableCell className="font-medium">
                  {monthLabel(p.month)}
                  {p.reopen_reason && p.status === 'OPEN' && (
                    <div className="text-xs font-normal text-muted-foreground">Reopened: {p.reopen_reason}</div>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={p.status === 'CLOSED' ? 'CLOSED' : p.month === current ? 'ACTIVE' : 'OPEN'} />
                </TableCell>
                <TableCell className="text-right">
                  {p.status === 'CLOSED' ? (
                    <Button size="sm" variant="outline" onClick={() => setReopening(p)}>
                      Reopen
                    </Button>
                  ) : (
                    p.month < current && (
                      <Button size="sm" variant="outline" disabled={closing.isPending} onClick={() => closing.mutate(p.month)}>
                        Close month
                      </Button>
                    )
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        A closed month takes no postings — a purchase, payment or payout dated in it is
        refused, and corrections go into the current month.
      </p>
      <ReverseDialog
        target={
          reopening
            ? {
                title: `Reopen ${monthLabel(reopening.month)}`,
                description: 'Postings dated in this month will be accepted again. The reason is kept in the audit trail.',
                confirmLabel: 'Reopen',
              }
            : null
        }
        onOpenChange={(o) => !o && setReopening(null)}
        onConfirm={(reason) => reopening && reopenMut.mutate({ month: reopening.month, reason })}
        pending={reopenMut.isPending}
      />
    </div>
  )
}

