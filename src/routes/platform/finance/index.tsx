import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Landmark, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import {
  getSourceWiseStockFn,
  getTodayLimitApprovalsFn,
  getUsdStockSummaryFn,
  listUsdPurchasesFn,
  listUsdSalesFn,
  listUsdSourcesFn,
  setUsdSourceActiveFn,
} from '@/server/platform/finance.fns'
import { bankName } from '@/schemas/usd-inventory'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime, fmtRate } from '@/components/platform/finance/format'
import { AddPurchaseDialog } from '@/components/platform/finance/purchase-dialog'
import { FeeRulesTab } from '@/components/platform/finance/fee-rules-tab'
import { InventoryTab } from '@/components/platform/finance/inventory-tab'
import { JournalTab } from '@/components/platform/finance/journal-tab'
import { MetaAccountsTab } from '@/components/platform/finance/meta-accounts-tab'
import { AgencyBillingTab, AgencyPaymentDialog } from '@/components/platform/finance/agency-billing-tab'
import { SalesTable } from '@/components/platform/finance/sales-table'
import { SourceDialog } from '@/components/platform/finance/source-dialog'
import type { EditableSource } from '@/components/platform/finance/source-dialog'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { StatusBadge } from '@/components/shared/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/**
 * Platform Management -> Finance & Accounts (spec §6.5): the platform's USD/BDT
 * stock ledger. Not the agency's own Finance page (/agency/finance) — that is
 * one agency's spread against its clients; this is what the platform paid for
 * its dollars and what it charged agencies.
 */
export const Route = createFileRoute('/platform/finance/')({
  component: PlatformFinancePage,
})

const ALL_SOURCES = 'all'

/** Positive is money in (green), negative is money out (red); null is unknown. */
function signClass(value: string | null): string {
  if (value === null) return ''
  return dec(value).isNegative() ? 'text-danger' : 'text-success'
}

function PlatformFinancePage() {
  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentPreset, setPaymentPreset] = useState<string | undefined>(undefined)

  function openPayment(organizationId?: string) {
    setPaymentPreset(organizationId)
    setPaymentOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="Finance & Accounts"
        description="The platform's USD stock, Meta accounts, and what agencies owe it."
      >
        <Button variant="outline" onClick={() => setPurchaseOpen(true)}>
          <Plus className="size-4" />
          Add USD purchase
        </Button>
        <Button onClick={() => openPayment()}>
          <Plus className="size-4" />
          Record agency payment
        </Button>
      </PageHeader>

      <Tabs defaultValue="stock">
        {/* Seven tabs don't fit a phone: the bar scrolls inside itself instead
            of pushing the page sideways (same as the ad account page). */}
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="stock">USD Stock</TabsTrigger>
          <TabsTrigger value="inventory">Inventory (FIFO)</TabsTrigger>
          <TabsTrigger value="meta">Meta Accounts</TabsTrigger>
          <TabsTrigger value="sources">Source Summary</TabsTrigger>
          <TabsTrigger value="agencies">Agencies</TabsTrigger>
          <TabsTrigger value="journal">Journal</TabsTrigger>
          <TabsTrigger value="fees">Fee Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="space-y-6">
          <StockTab />
        </TabsContent>
        <TabsContent value="inventory" className="space-y-6">
          <InventoryTab />
        </TabsContent>
        <TabsContent value="meta" className="space-y-6">
          <MetaAccountsTab />
        </TabsContent>
        <TabsContent value="sources" className="space-y-6">
          <SourcesTab />
        </TabsContent>
        <TabsContent value="agencies" className="space-y-6">
          <AgencyBillingTab onRecordPayment={openPayment} />
        </TabsContent>
        <TabsContent value="journal" className="space-y-6">
          <JournalTab />
        </TabsContent>
        <TabsContent value="fees" className="space-y-6">
          <FeeRulesTab />
        </TabsContent>
      </Tabs>

      <AddPurchaseDialog open={purchaseOpen} onOpenChange={setPurchaseOpen} />
      <AgencyPaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        presetOrganizationId={paymentPreset}
      />
    </div>
  )
}

// ----------------------------------------------------------------- USD stock ---

function StockTab() {
  const getSummary = useServerFn(getUsdStockSummaryFn)
  const getToday = useServerFn(getTodayLimitApprovalsFn)
  const listSales = useServerFn(listUsdSalesFn)

  const { data: s, isLoading, error } = useQuery({
    queryKey: ['platform-usd', 'summary'],
    queryFn: () => getSummary(),
  })
  const today = useQuery({
    queryKey: ['platform-usd', 'limits-today'],
    queryFn: () => getToday(),
  })
  const recent = useQuery({
    queryKey: ['platform-usd', 'sales', 'recent'],
    queryFn: () => listSales({ data: { limit: 10 } }),
  })

  const oversold = s && dec(s.remaining_usd_stock).isNegative()

  return (
    <>
      {!!error && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>Couldn't load the stock summary</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'unknown error'}
          </AlertDescription>
        </Alert>
      )}

      {oversold && s && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertTitle>More USD has been sold than bought</AlertTitle>
          <AlertDescription>
            Sales exceed purchases by {formatUsd(dec(s.remaining_usd_stock).abs())}. That
            usually means a purchase has not been recorded yet.
          </AlertDescription>
        </Alert>
      )}

      {/* Nine tiles, three to a row on a wide screen: dollars, then taka, then
          rates and value — each row reads as one thought. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Total USD purchased"
          value={s && formatUsd(s.total_usd_purchased)}
          loading={isLoading}
        />
        <StatCard
          label="Total USD sold"
          hint="Allocated to agencies"
          value={s && formatUsd(s.total_usd_sold)}
          loading={isLoading}
        />
        <StatCard
          label="Remaining USD stock"
          value={s && formatUsd(s.remaining_usd_stock)}
          valueClassName={oversold ? 'text-danger' : undefined}
          loading={isLoading}
        />
        <StatCard
          label="Total BDT invested"
          hint="Paid to sources"
          value={s && formatBdt(s.total_bdt_invested)}
          loading={isLoading}
        />
        <StatCard
          label="Total BDT received"
          hint="From agencies"
          value={s && formatBdt(s.total_bdt_received)}
          loading={isLoading}
        />
        <StatCard
          label="Gross BDT difference"
          hint="Received − cost of the USD sold"
          value={s && (s.gross_bdt_difference === null ? '—' : formatBdt(s.gross_bdt_difference))}
          valueClassName={s ? signClass(s.gross_bdt_difference) : undefined}
          loading={isLoading}
        />
        <StatCard
          label="Average buying rate"
          hint="BDT per USD, weighted"
          value={s && (s.avg_buying_rate === null ? '—' : `৳${fmtRate(s.avg_buying_rate)}`)}
          loading={isLoading}
        />
        <StatCard
          label="Average selling rate"
          hint="BDT per USD, weighted"
          value={s && (s.avg_selling_rate === null ? '—' : `৳${fmtRate(s.avg_selling_rate)}`)}
          loading={isLoading}
        />
        <StatCard
          label="Remaining stock value"
          hint="Remaining USD at the average buying rate"
          value={
            s && (s.remaining_stock_bdt_value === null ? '—' : formatBdt(s.remaining_stock_bdt_value))
          }
          loading={isLoading}
        />
      </div>

      {/* Display only: approvals never feed the stock position above (an
          approval carries no BDT). The day is the Asia/Dhaka business day. */}
      <div>
        <h2 className="mb-3 text-lg font-semibold">Today</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Approved limit requests today"
            hint={
              today.error
                ? "Couldn't load today's approvals"
                : today.data
                  ? `${today.data.count} ${today.data.count === 1 ? 'request' : 'requests'} · business day ${today.data.day} (Asia/Dhaka)`
                  : 'On platform accounts, all agencies'
            }
            value={today.data && formatUsd(today.data.usd)}
            loading={today.isLoading}
          />
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Recent sales</h2>
        <SalesTable
          sales={recent.data}
          isLoading={recent.isLoading}
          error={recent.error}
          emptyText="No sales recorded yet — use “Record agency sale”."
        />
      </div>
    </>
  )
}

// ------------------------------------------------------------- source summary ---

function SourcesTab() {
  const queryClient = useQueryClient()
  const getReport = useServerFn(getSourceWiseStockFn)
  const listPurchases = useServerFn(listUsdPurchasesFn)
  const setActive = useServerFn(setUsdSourceActiveFn)
  const listSources = useServerFn(listUsdSourcesFn)
  // One dialog for both jobs: `editing` null means "new source".
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const [editing, setEditing] = useState<EditableSource | null>(null)
  const [filter, setFilter] = useState(ALL_SOURCES)

  function openSourceDialog(source: EditableSource | null) {
    setEditing(source)
    setSourceDialogOpen(true)
  }

  const report = useQuery({
    queryKey: ['platform-usd', 'source-stock'],
    queryFn: () => getReport(),
  })
  const purchases = useQuery({
    queryKey: ['platform-usd', 'purchases', filter],
    queryFn: () =>
      listPurchases({ data: filter === ALL_SOURCES ? {} : { source_id: filter } }),
  })

  const sources = useQuery({
    queryKey: ['platform-usd', 'sources'],
    queryFn: () => listSources(),
  })
  const bankOf = new Map((sources.data ?? []).map((s) => [s.id, s.receiving_institution]))

  const toggle = useMutation({
    mutationFn: (vars: { id: string; is_active: boolean }) => setActive({ data: vars }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-usd'] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const rows = report.data?.rows ?? []
  const oversold = report.data && dec(report.data.oversold_usd).gt(0)

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Active sources"
          value={report.data?.active_source_count}
          loading={report.isLoading}
        />
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Stock by source</h2>
          <Button size="sm" variant="outline" onClick={() => openSourceDialog(null)}>
            <Plus className="size-4" />
            New source
          </Button>
        </div>

        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Payment method</TableHead>
                <TableHead>Receiving bank</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Purchased</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead className="text-right">Buying rate</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.isLoading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={9}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))}

              {!!report.error && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <div className="py-10 text-center text-sm text-destructive">
                      Couldn't load sources:{' '}
                      {report.error instanceof Error ? report.error.message : 'unknown error'}
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {!report.isLoading && !report.error && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                      <Landmark className="size-8 opacity-40" />
                      No sources yet. Add the first one to start recording purchases.
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {rows.map((r) => (
                <TableRow key={r.source_id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    {r.payment_method ?? (
                      // Created before the column existed — say so, and the
                      // Edit button beside it is how it gets one.
                      <span className="text-muted-foreground italic">Not set</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {bankOf.get(r.source_id) ? (
                      bankName(bankOf.get(r.source_id))
                    ) : (
                      <span className="text-muted-foreground italic">Not set</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.is_active ? 'ACTIVE' : 'INACTIVE'} />
                  </TableCell>
                  <TableCell className="num text-right">{formatUsd(r.purchased_usd)}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {formatUsd(r.allocated_usd)}
                  </TableCell>
                  <TableCell className="num text-right font-medium">
                    {formatUsd(r.remaining_usd)}
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {r.avg_buying_rate === null ? '—' : `৳${fmtRate(r.avg_buying_rate)}`}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          openSourceDialog({
                            id: r.source_id,
                            name: r.name,
                            payment_method: r.payment_method,
                            receiving_institution: bankOf.get(r.source_id) ?? null,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={toggle.isPending}
                        onClick={() =>
                          toggle.mutate({ id: r.source_id, is_active: !r.is_active })
                        }
                      >
                        {r.is_active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <p className="mt-2 text-xs text-muted-foreground">
          A sale does not name the source it used, so “allocated” is worked out
          oldest purchase first across all sources.
          {oversold && report.data && (
            <>
              {' '}
              <span className="text-foreground">
                {formatUsd(report.data.oversold_usd)} sold is beyond everything purchased.
              </span>
            </>
          )}
        </p>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Purchase history</h2>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-44" aria-label="Filter by source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SOURCES}>All sources</SelectItem>
              {rows.map((r) => (
                <SelectItem key={r.source_id} value={r.source_id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Purchased</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">USD</TableHead>
                <TableHead className="text-right">BDT paid</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchases.isLoading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))}

              {!!purchases.error && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <div className="py-10 text-center text-sm text-destructive">
                      Couldn't load purchases:{' '}
                      {purchases.error instanceof Error ? purchases.error.message : 'unknown error'}
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {!purchases.isLoading && !purchases.error && (purchases.data?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                      <Landmark className="size-8 opacity-40" />
                      No purchases recorded yet.
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {purchases.data?.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {fmtDateTime(p.purchased_at)}
                  </TableCell>
                  <TableCell>
                    {p.source?.name ?? '—'}
                    {p.source?.payment_method && (
                      <div className="text-xs text-muted-foreground">
                        {p.source.payment_method}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.method ?? '—'}</TableCell>
                  <TableCell className="num text-right">{formatUsd(p.usd_amount)}</TableCell>
                  <TableCell className="num text-right">{formatBdt(p.bdt_amount)}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {fmtRate(p.buying_rate)}
                  </TableCell>
                  <TableCell className="max-w-xs whitespace-normal text-sm text-muted-foreground">
                    {p.notes ?? ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <SourceDialog open={sourceDialogOpen} onOpenChange={setSourceDialogOpen} source={editing} />
    </>
  )
}
