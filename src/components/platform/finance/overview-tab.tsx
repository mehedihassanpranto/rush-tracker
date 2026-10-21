import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { CircleCheck, CircleDashed, TriangleAlert } from 'lucide-react'

import { getFinanceOverviewFn } from '@/server/platform/finance-close.fns'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime } from '@/components/platform/finance/format'
import { StatCard } from '@/components/shared/stat-card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'

/**
 * Finance v2 (Milestone 5): the platform's position at a glance, plus the
 * go-live checklist from the plan. Replaces the weighted-average "USD Stock"
 * tab, whose sales-based figures no longer matched how the business runs.
 */
export function OverviewTab({ onGoTo }: { onGoTo: (tab: string) => void }) {
  const get = useServerFn(getFinanceOverviewFn)
  const q = useQuery({ queryKey: ['platform-usd', 'overview'], queryFn: () => get() })
  const o = q.data
  const m = o?.month

  const steps = o
    ? [
        { done: o.checklist.opening_stock_set, text: 'Opening USD stock set (Inventory → Set opening stock)', tab: 'inventory' },
        { done: o.checklist.opening_bank_set, text: 'Opening bank balance entered (Reconcile)', tab: 'reconcile' },
        {
          done: o.checklist.suppliers_without_bank.length === 0,
          text: o.checklist.suppliers_without_bank.length
            ? `Receiving bank missing for ${o.checklist.suppliers_without_bank.join(', ')} (Suppliers)`
            : 'Every active supplier has a receiving bank',
          tab: 'sources',
        },
        {
          done: o.checklist.agencies_without_rate.length === 0,
          text: o.checklist.agencies_without_rate.length
            ? `No USD rate yet for ${o.checklist.agencies_without_rate.join(', ')} (Agencies)`
            : 'Every agency has a USD rate',
          tab: 'agencies',
        },
        {
          done: o.checklist.pending_rate_charges === 0,
          text: o.checklist.pending_rate_charges
            ? `${o.checklist.pending_rate_charges} approval(s) waiting for a rate (Agencies)`
            : 'No approval is waiting for a rate',
          tab: 'agencies',
        },
        {
          done: o.checklist.open_meta_exceptions === 0,
          text: o.checklist.open_meta_exceptions
            ? `${o.checklist.open_meta_exceptions} Meta spend item(s) to review (Meta Accounts)`
            : 'No Meta spend to review',
          tab: 'meta',
        },
        {
          done: o.checklist.open_reconciliation_differences === 0 && !!o.last_reconciliation.USD_WALLETS,
          text: o.last_reconciliation.USD_WALLETS
            ? o.checklist.open_reconciliation_differences
              ? `${o.checklist.open_reconciliation_differences} reconciliation difference(s) to resolve (Reconcile)`
              : `Wallets last reconciled ${fmtDateTime(o.last_reconciliation.USD_WALLETS.at)}`
            : 'Wallet balances not reconciled yet (Reconcile)',
          tab: 'reconcile',
        },
      ]
    : []

  return (
    <>
      {!!q.error && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>Couldn't load the overview</AlertTitle>
          <AlertDescription>{q.error instanceof Error ? q.error.message : 'unknown error'}</AlertDescription>
        </Alert>
      )}
      {o && !o.books_tie && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>The books don't agree with the stock</AlertTitle>
          <AlertDescription>
            The USD inventory or prepaid accounts in the journal differ from the FIFO stock. See the Journal tab.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="USD in stock" hint="FIFO, at cost" value={o ? formatUsd(o.stock_usd) : undefined} loading={q.isLoading} highlight />
        <StatCard label="Stock value at cost" hint="What those dollars cost, fees included" value={o ? formatBdt(o.stock_bdt) : undefined} loading={q.isLoading} />
        <StatCard
          label="Agencies owe you"
          hint={o && dec(o.agencies_advance_bdt).gt(0) ? `Paid ahead: ${formatBdt(o.agencies_advance_bdt)}` : 'Billed − paid'}
          value={o ? formatBdt(o.agencies_owed_bdt) : undefined}
          loading={q.isLoading}
        />
        <StatCard label="Owed to Meta" hint="Postpaid spend not yet paid" value={o ? formatUsd(o.owed_to_meta_usd) : undefined} loading={q.isLoading} />
        <StatCard label="Revenue this month" hint="Approvals billed to agencies" value={m ? formatBdt(m.revenue_bdt) : undefined} loading={q.isLoading} />
        <StatCard
          label="Gross profit this month"
          hint={m ? `Meta cost ${formatBdt(m.meta_cost_bdt)}` : 'Revenue − Meta cost'}
          value={m ? formatBdt(m.gross_profit_bdt) : undefined}
          loading={q.isLoading}
        />
      </div>
      {m && (dec(m.unpaid_meta_usd).gt(0) || dec(m.billed_unspent_usd).gt(0)) && (
        <p className="text-xs text-muted-foreground">
          Costs still to come: {formatUsd(m.unpaid_meta_usd)} of Meta spend not yet paid for, and{' '}
          {formatUsd(m.billed_unspent_usd)} billed to agencies but not yet spent. See Profit.
        </p>
      )}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Go-live checklist</h2>
        <Card className="divide-y p-0">
          {q.isLoading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
          {steps.map((s) => (
            <button
              key={s.text}
              type="button"
              onClick={() => onGoTo(s.tab)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent/50"
            >
              {s.done ? (
                <CircleCheck className="size-4 shrink-0 text-success" />
              ) : (
                <CircleDashed className="size-4 shrink-0 text-warning" />
              )}
              <span className={s.done ? 'text-muted-foreground' : ''}>{s.text}</span>
            </button>
          ))}
        </Card>
      </div>
    </>
  )
}
