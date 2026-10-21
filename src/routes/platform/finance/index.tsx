import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Landmark, Plus } from 'lucide-react'
import { toast } from 'sonner'

import {
  listUsdPurchasesFn,
  setUsdSourceActiveFn,
} from '@/server/platform/finance.fns'
import { listSupplierStockFn } from '@/server/platform/finance-close.fns'
import { bankName } from '@/schemas/usd-inventory'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { fmtDateTime, fmtRate } from '@/components/platform/finance/format'
import { AddPurchaseDialog } from '@/components/platform/finance/purchase-dialog'
import { AgencyBillingTab, AgencyPaymentDialog } from '@/components/platform/finance/agency-billing-tab'
import { FeeRulesTab } from '@/components/platform/finance/fee-rules-tab'
import { InventoryTab } from '@/components/platform/finance/inventory-tab'
import { JournalTab } from '@/components/platform/finance/journal-tab'
import { MetaAccountsTab } from '@/components/platform/finance/meta-accounts-tab'
import { OverviewTab } from '@/components/platform/finance/overview-tab'
import { ProfitTab } from '@/components/platform/finance/profit-tab'
import { ReconcileTab } from '@/components/platform/finance/reconcile-tab'
import { SourceDialog } from '@/components/platform/finance/source-dialog'
import type { EditableSource } from '@/components/platform/finance/source-dialog'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
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
 * Platform Management -> Finance & Accounts: the platform's own books (Finance
 * v2, docs/ACCOUNTING_POLICY.md) — USD bought from suppliers and held at FIFO
 * cost, Meta accounts, what agencies owe, the journal and profit. Not an
 * agency's Finance page (/agency/finance): that is one agency's spread against
 * its clients.
 */
export const Route = createFileRoute('/platform/finance/')({
  component: PlatformFinancePage,
})

const ALL_SOURCES = 'all'

function PlatformFinancePage() {
  const [tab, setTab] = useState('overview')
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
        description="The platform's USD stock, Meta accounts, what agencies owe it, and profit."
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

      <Tabs value={tab} onValueChange={setTab}>
        {/* Nine tabs don't fit a phone: the bar scrolls inside itself instead
            of pushing the page sideways (same as the ad account page). */}
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="inventory">Inventory (FIFO)</TabsTrigger>
          <TabsTrigger value="meta">Meta Accounts</TabsTrigger>
          <TabsTrigger value="agencies">Agencies</TabsTrigger>
          <TabsTrigger value="profit">Profit</TabsTrigger>
          <TabsTrigger value="reconcile">Reconcile</TabsTrigger>
          <TabsTrigger value="journal">Journal</TabsTrigger>
          <TabsTrigger value="sources">Suppliers</TabsTrigger>
          <TabsTrigger value="fees">Fee Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <OverviewTab onGoTo={setTab} />
        </TabsContent>
        <TabsContent value="inventory" className="space-y-6">
          <InventoryTab />
        </TabsContent>
        <TabsContent value="meta" className="space-y-6">
          <MetaAccountsTab />
        </TabsContent>
        <TabsContent value="agencies" className="space-y-6">
          <AgencyBillingTab onRecordPayment={openPayment} />
        </TabsContent>
        <TabsContent value="profit" className="space-y-6">
          <ProfitTab />
        </TabsContent>
        <TabsContent value="reconcile" className="space-y-6">
          <ReconcileTab />
        </TabsContent>
        <TabsContent value="journal" className="space-y-6">
          <JournalTab />
        </TabsContent>
        <TabsContent value="sources" className="space-y-6">
          <SuppliersTab />
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

// ---------------------------------------------------------------- suppliers ---

/** Who the platform buys USD from: what each sold it, at what cost, and what
 * of it is still in stock (FIFO) — plus every purchase. */
function SuppliersTab() {
  const queryClient = useQueryClient()
  const listSuppliers = useServerFn(listSupplierStockFn)
  const listPurchases = useServerFn(listUsdPurchasesFn)
  const setActive = useServerFn(setUsdSourceActiveFn)
  // One dialog for both jobs: `editing` null means "new supplier".
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const [editing, setEditing] = useState<EditableSource | null>(null)
  const [filter, setFilter] = useState(ALL_SOURCES)

  function openSourceDialog(source: EditableSource | null) {
    setEditing(source)
    setSourceDialogOpen(true)
  }

  const suppliers = useQuery({ queryKey: ['platform-usd', 'supplier-stock'], queryFn: () => listSuppliers() })
  const purchases = useQuery({
    queryKey: ['platform-usd', 'purchases', filter],
    queryFn: () => listPurchases({ data: filter === ALL_SOURCES ? {} : { source_id: filter } }),
  })
  const toggle = useMutation({
    mutationFn: (vars: { id: string; is_active: boolean }) => setActive({ data: vars }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-usd'] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const rows = suppliers.data ?? []

  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Suppliers</h2>
          <Button size="sm" variant="outline" onClick={() => openSourceDialog(null)}>
            <Plus className="size-4" />
            New supplier
          </Button>
        </div>
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Pays in</TableHead>
                <TableHead>Receiving bank</TableHead>
                <TableHead className="text-right">Bought (net)</TableHead>
                <TableHead className="text-right">Avg. cost</TableHead>
                <TableHead className="text-right">In stock</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.isLoading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {!!suppliers.error && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-sm text-destructive">
                    {suppliers.error instanceof Error ? suppliers.error.message : 'Could not load'}
                  </TableCell>
                </TableRow>
              )}
              {!suppliers.isLoading && !suppliers.error && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8}>
                    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                      <Landmark className="size-8 opacity-40" />
                      No suppliers yet. Add the first one to start recording purchases.
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.source_id}>
                  <TableCell className="font-medium">
                    {r.name}
                    <div className="text-xs font-normal text-muted-foreground">
                      {r.batches} batch{r.batches === 1 ? '' : 'es'}
                    </div>
                  </TableCell>
                  <TableCell>{r.payment_method ?? <span className="text-muted-foreground italic">Not set</span>}</TableCell>
                  <TableCell>
                    {r.receiving_institution ? bankName(r.receiving_institution) : <span className="text-warning italic">Not set</span>}
                  </TableCell>
                  <TableCell className="num text-right">
                    {formatUsd(r.net_usd)}
                    <div className="text-xs text-muted-foreground">{formatBdt(r.cost_bdt)}</div>
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {r.avg_effective_rate ? `৳${fmtRate(r.avg_effective_rate)}` : '—'}
                  </TableCell>
                  <TableCell className="num text-right font-medium">
                    {formatUsd(r.left_usd)}
                    <div className="text-xs font-normal text-muted-foreground">{formatBdt(r.left_bdt)}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.is_active ? 'ACTIVE' : 'INACTIVE'} />
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
                            receiving_institution: r.receiving_institution,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate({ id: r.source_id, is_active: !r.is_active })}
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
          Avg. cost is what this supplier's dollars cost you per USD, fees included. "In stock" is how much of
          it is still unused, oldest purchases being used first.
        </p>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Purchase history</h2>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-44" aria-label="Filter by supplier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SOURCES}>All suppliers</SelectItem>
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
                <TableHead>Supplier</TableHead>
                <TableHead>Paid from</TableHead>
                <TableHead className="text-right">USD</TableHead>
                <TableHead className="text-right">Cost</TableHead>
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
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-destructive">
                    Couldn't load purchases: {purchases.error instanceof Error ? purchases.error.message : 'unknown error'}
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
                  <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(p.purchased_at)}</TableCell>
                  <TableCell>
                    {p.source?.name ?? 'Prepaid credit returned'}
                    {p.source?.payment_method && (
                      <div className="text-xs text-muted-foreground">{p.source.payment_method}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.method ?? '—'}</TableCell>
                  <TableCell className="num text-right">{formatUsd(p.usd_amount)}</TableCell>
                  <TableCell className="num text-right">{formatBdt(p.bdt_amount)}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">{fmtRate(p.buying_rate)}</TableCell>
                  <TableCell className="max-w-xs whitespace-normal text-sm text-muted-foreground">{p.notes ?? ''}</TableCell>
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
