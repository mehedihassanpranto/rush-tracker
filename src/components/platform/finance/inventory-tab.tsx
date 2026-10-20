import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Landmark, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import {
  getUsdFifoSummaryFn,
  listUsdBatchesFn,
  listUsdOutflowsFn,
  reverseUsdOutflowFn,
  reverseUsdPurchaseFn,
} from '@/server/platform/usd-inventory.fns'
import { OUTFLOW_KIND_LABELS } from '@/schemas/usd-inventory'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime, fmtRate } from '@/components/platform/finance/format'
import {
  OpeningStockDialog,
  OutflowDialog,
  ReverseDialog,
} from '@/components/platform/finance/inventory-dialogs'
import type { UsdBatchRow, UsdOutflowRow } from '@/server/platform/usd-inventory.fns'
import { StatCard } from '@/components/shared/stat-card'
import { StatusBadge } from '@/components/shared/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type Reversal =
  | { kind: 'batch'; row: UsdBatchRow }
  | { kind: 'outflow'; row: UsdOutflowRow }

/**
 * Finance v2 FIFO inventory (migration 000059): what is really in the
 * wallets, batch by batch, at what it cost including the fees you bore.
 *
 * Deliberately separate from the USD Stock tab. That tab's "remaining" is
 * purchased − sold to agencies (weighted average); this one is purchased −
 * paid out (Meta bills), FIFO. Two different questions, two labels.
 */
export function InventoryTab() {
  const queryClient = useQueryClient()
  const getSummary = useServerFn(getUsdFifoSummaryFn)
  const listBatches = useServerFn(listUsdBatchesFn)
  const listOutflows = useServerFn(listUsdOutflowsFn)
  const reverseBatch = useServerFn(reverseUsdPurchaseFn)
  const reverseOutflow = useServerFn(reverseUsdOutflowFn)

  const [outflowOpen, setOutflowOpen] = useState(false)
  const [openingOpen, setOpeningOpen] = useState(false)
  const [reversing, setReversing] = useState<Reversal | null>(null)

  const summary = useQuery({ queryKey: ['platform-usd', 'fifo-summary'], queryFn: () => getSummary() })
  const batches = useQuery({ queryKey: ['platform-usd', 'batches'], queryFn: () => listBatches() })
  const outflows = useQuery({ queryKey: ['platform-usd', 'outflows'], queryFn: () => listOutflows() })

  const reverse = useMutation({
    mutationFn: ({ target, reason }: { target: Reversal; reason: string }) =>
      target.kind === 'batch'
        ? reverseBatch({ data: { id: target.row.id, reason } })
        : reverseOutflow({ data: { id: target.row.id, reason } }),
    onSuccess: () => {
      toast.success('Reversed')
      void queryClient.invalidateQueries({ queryKey: ['platform-usd'] })
      setReversing(null)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const s = summary.data
  const hasLegacy = (batches.data ?? []).some((b) => b.is_opening && b.status === 'POSTED')
  const needsCutover = !!s && hasLegacy && !s.has_opening_adjustment

  return (
    <>
      {!!summary.error && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>Couldn't load the inventory</AlertTitle>
          <AlertDescription>
            {summary.error instanceof Error ? summary.error.message : 'unknown error'}
          </AlertDescription>
        </Alert>
      )}

      {needsCutover && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertTitle>Set your opening stock</AlertTitle>
          <AlertDescription>
            <p>
              Purchases recorded before this inventory existed all count as still in
              stock. Enter what is really in your wallets today so the figures below
              are true.
            </p>
            <Button size="sm" className="mt-2" onClick={() => setOpeningOpen(true)}>
              Set opening stock
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="USD in stock"
          hint="Bought, minus paid out — oldest batch used first"
          value={s ? formatUsd(s.left_usd) : undefined}
          loading={summary.isLoading}
          highlight
        />
        <StatCard
          label="Stock value at cost"
          hint="What the USD in stock cost, fees included"
          value={s ? formatBdt(s.left_bdt) : undefined}
          loading={summary.isLoading}
        />
        <StatCard
          label="Average cost of stock"
          hint="BDT per USD still in stock"
          value={s ? (s.avg_cost_left ? `৳${fmtRate(s.avg_cost_left)}` : '—') : undefined}
          loading={summary.isLoading}
        />
        <StatCard
          label="USD paid out"
          hint="Meta bills and other outflows"
          value={s ? formatUsd(s.out_usd) : undefined}
          loading={summary.isLoading}
        />
        <StatCard
          label="Cost of USD paid out"
          hint="FIFO cost of those dollars"
          value={s ? formatBdt(s.out_bdt) : undefined}
          loading={summary.isLoading}
        />
        <StatCard
          label="Open batches"
          hint="Purchases with dollars left"
          value={s?.open_batches}
          loading={summary.isLoading}
        />
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">USD paid out</h2>
          <Button size="sm" onClick={() => setOutflowOpen(true)}>
            <Plus className="size-4" />
            Record USD paid out
          </Button>
        </div>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Paid</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="text-right">USD</TableHead>
                <TableHead className="text-right">FIFO cost</TableHead>
                <TableHead>Drawn from</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <LoadingRows q={outflows} cols={8} empty="Nothing paid out yet." />
              {outflows.data?.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {fmtDateTime(o.event_at)}
                  </TableCell>
                  <TableCell className="num">{o.reference_id}</TableCell>
                  <TableCell>
                    {OUTFLOW_KIND_LABELS[o.kind]}
                    <div className="max-w-xs text-xs whitespace-normal text-muted-foreground">
                      {o.ad_account ? `${o.ad_account.account_code} · ${o.ad_account.name}` : o.notes}
                    </div>
                  </TableCell>
                  <TableCell className="num text-right">{formatUsd(o.usd_amount)}</TableCell>
                  <TableCell className="num text-right">{formatBdt(o.bdt_cost)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {o.allocations
                      .filter((a) => !a.is_reversal)
                      .map((a) => `#${a.batch_seq}: ${formatUsd(a.usd)}`)
                      .join(', ')}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} />
                    {o.reversal_reason && (
                      <div className="mt-1 max-w-[12rem] text-xs whitespace-normal text-muted-foreground">
                        {o.reversal_reason}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {o.status === 'POSTED' && (
                      <Button size="sm" variant="outline" onClick={() => setReversing({ kind: 'outflow', row: o })}>
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

      <div>
        <h2 className="mb-3 text-lg font-semibold">Batches</h2>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Purchased</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">USD sent</TableHead>
                <TableHead>Fees</TableHead>
                <TableHead className="text-right">Net USD</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Eff. rate</TableHead>
                <TableHead className="text-right">Left</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <LoadingRows q={batches} cols={11} empty="No purchases recorded yet." />
              {batches.data?.map((b) => (
                <TableRow key={b.id} className={b.status === 'REVERSED' ? 'opacity-60' : undefined}>
                  <TableCell className="num text-muted-foreground">{b.posting_seq}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {fmtDateTime(b.purchased_at)}
                    {b.is_opening && <div className="text-xs">Recorded before v2</div>}
                  </TableCell>
                  <TableCell>
                    {b.source?.name ?? '—'}
                    {b.external_reference && (
                      <div className="max-w-[10rem] truncate text-xs text-muted-foreground">
                        {b.external_reference}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">{formatUsd(b.gross_usd)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {b.fees.length === 0
                      ? '—'
                      : b.fees.map((f, i) => (
                          <div key={i} className="whitespace-nowrap">
                            {f.label ?? f.currency}:{' '}
                            {f.currency === 'USD' ? formatUsd(f.total) : formatBdt(f.total)}
                            {dec(f.your_share).lt(f.total) && ` (you ${f.currency === 'USD' ? formatUsd(f.your_share) : formatBdt(f.your_share)})`}
                          </div>
                        ))}
                    {b.rate_warning && <div className="text-warning">Rate outside ৳124–131</div>}
                  </TableCell>
                  <TableCell className="num text-right">{formatUsd(b.net_usd)}</TableCell>
                  <TableCell className="num text-right">
                    {formatBdt(b.total_bdt_cost)}
                    {dec(b.capitalized_fees_bdt).gt(0) && (
                      <div className="text-xs text-muted-foreground">
                        incl. {formatBdt(b.capitalized_fees_bdt)} fees
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">৳{fmtRate(b.effective_rate)}</TableCell>
                  <TableCell className="num text-right font-medium">
                    {b.status === 'POSTED' ? formatUsd(b.left_usd) : '—'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={b.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    {b.status === 'POSTED' && dec(b.used_usd).isZero() && (
                      <Button size="sm" variant="outline" onClick={() => setReversing({ kind: 'batch', row: b })}>
                        Reverse
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        <p className="mt-2 text-xs text-muted-foreground">
          Cost is the BDT paid plus the fees you bore; the effective rate is cost ÷ net
          USD. A batch can be reversed only while none of its dollars have been used.
        </p>
      </div>

      <OutflowDialog open={outflowOpen} onOpenChange={setOutflowOpen} />
      <OpeningStockDialog
        open={openingOpen}
        onOpenChange={setOpeningOpen}
        recordedUsd={s?.left_usd ?? '0'}
      />
      <ReverseDialog
        target={
          reversing
            ? reversing.kind === 'batch'
              ? {
                  title: `Reverse batch #${reversing.row.posting_seq}`,
                  description: `${formatUsd(reversing.row.net_usd)} from ${reversing.row.source?.name ?? 'this source'} leaves the inventory. The record stays, marked reversed.`,
                }
              : {
                  title: `Reverse ${reversing.row.reference_id}`,
                  description: `${formatUsd(reversing.row.usd_amount)} goes back into the batches it came from, at the same cost. The record stays, marked reversed.`,
                }
            : null
        }
        onOpenChange={(o) => !o && setReversing(null)}
        onConfirm={(reason) => reversing && reverse.mutate({ target: reversing, reason })}
        pending={reverse.isPending}
      />
    </>
  )
}

function LoadingRows({
  q,
  cols,
  empty,
}: {
  q: { isLoading: boolean; error: unknown; data?: Array<unknown> }
  cols: number
  empty: string
}) {
  if (q.isLoading) {
    return (
      <>
        {Array.from({ length: 3 }).map((_, i) => (
          <TableRow key={i}>
            <TableCell colSpan={cols}>
              <Skeleton className="h-6 w-full" />
            </TableCell>
          </TableRow>
        ))}
      </>
    )
  }
  if (q.error) {
    return (
      <TableRow>
        <TableCell colSpan={cols}>
          <div className="py-10 text-center text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : 'Could not load'}
          </div>
        </TableCell>
      </TableRow>
    )
  }
  if ((q.data?.length ?? 0) === 0) {
    return (
      <TableRow>
        <TableCell colSpan={cols}>
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Landmark className="size-8 opacity-40" />
            {empty}
          </div>
        </TableCell>
      </TableRow>
    )
  }
  return null
}
