import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { BarChart3, Download } from 'lucide-react'

import { listActiveClientsFn } from '@/server/ad-accounts/assignment.fns'
import {
  accountUsageReportFn,
  adjustmentReportFn,
  clientDueReportFn,
  limitApprovalReportFn,
  paymentCollectionReportFn,
  usdRateUsageReportFn,
} from '@/server/reports/report.fns'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { downloadCsv } from '@/lib/csv/csv'
import type { CsvColumn } from '@/lib/csv/csv'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const Route = createFileRoute('/admin/reports/')({
  component: ReportsPage,
})

const ALL = 'ALL'

type ReportKey =
  | 'client-due'
  | 'limit-approval'
  | 'payment-collection'
  | 'adjustment'
  | 'account-usage'
  | 'rate-usage'

interface ReportMeta {
  key: ReportKey
  label: string
  description: string
  date: boolean
  client: boolean
}

const REPORTS: Array<ReportMeta> = [
  {
    key: 'client-due',
    label: 'Client Due Report',
    description: 'Every client with total billed, paid and outstanding due.',
    date: false,
    client: false,
  },
  {
    key: 'limit-approval',
    label: 'Limit Approval Report',
    description: 'Approved limit requests with applied USD rate and BDT charge.',
    date: true,
    client: true,
  },
  {
    key: 'payment-collection',
    label: 'Payment Collection Report',
    description: 'Approved (collected) payments.',
    date: true,
    client: true,
  },
  {
    key: 'adjustment',
    label: 'Adjustment / Reversal Report',
    description: 'Manual due corrections and reversals.',
    date: true,
    client: true,
  },
  {
    key: 'account-usage',
    label: 'Ad Account Usage Report',
    description: 'Accounts with status, current limit and current holder.',
    date: false,
    client: false,
  },
  {
    key: 'rate-usage',
    label: 'USD Rate Usage Report',
    description: 'Approved limits grouped by the applied USD rate.',
    date: true,
    client: false,
  },
]

interface Filters {
  from: string
  to: string
  client_id: string
}
const EMPTY: Filters = { from: '', to: '', client_id: ALL }

function fmtDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function ReportsPage() {
  const getClients = useServerFn(listActiveClientsFn)
  const [reportKey, setReportKey] = useState<ReportKey>('client-due')
  const [draft, setDraft] = useState<Filters>(EMPTY)
  const [applied, setApplied] = useState<Filters>(EMPTY)

  const meta = REPORTS.find((r) => r.key === reportKey)!

  const { data: clients } = useQuery({
    queryKey: ['reports', 'clients'],
    queryFn: () => getClients(),
  })

  function changeReport(key: ReportKey) {
    setReportKey(key)
    setDraft(EMPTY)
    setApplied(EMPTY)
  }

  const filterArgs = {
    from: applied.from || undefined,
    to: applied.to || undefined,
    client_id: applied.client_id === ALL ? undefined : applied.client_id,
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Financial and operational reports (spec §71). Export any view to CSV."
      />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 lg:grid-cols-4 lg:items-end">
          <div className="space-y-1.5 lg:col-span-1">
            <Label className="text-xs">Report</Label>
            <Select value={reportKey} onValueChange={(v) => changeReport(v as ReportKey)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORTS.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {meta.client && (
            <div className="space-y-1.5">
              <Label className="text-xs">Client</Label>
              <Select
                value={draft.client_id}
                onValueChange={(v) => setDraft((d) => ({ ...d, client_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All clients</SelectItem>
                  {clients?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {meta.date && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={draft.from}
                  onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">To</Label>
                <Input
                  type="date"
                  value={draft.to}
                  onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                />
              </div>
            </>
          )}

          {(meta.date || meta.client) && (
            <div className="flex gap-2">
              <Button onClick={() => setApplied(draft)}>Apply</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(EMPTY)
                  setApplied(EMPTY)
                }}
              >
                Reset
              </Button>
            </div>
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{meta.description}</p>
      </Card>

      {reportKey === 'client-due' && <ClientDueReport />}
      {reportKey === 'limit-approval' && <LimitApprovalReport filters={filterArgs} />}
      {reportKey === 'payment-collection' && (
        <PaymentCollectionReport filters={filterArgs} />
      )}
      {reportKey === 'adjustment' && <AdjustmentReport filters={filterArgs} />}
      {reportKey === 'account-usage' && <AccountUsageReport />}
      {reportKey === 'rate-usage' && <RateUsageReport filters={filterArgs} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Generic report view: export toolbar + table.
// ---------------------------------------------------------------------------
interface Column<T> {
  header: string
  align?: 'right'
  cell: (row: T) => React.ReactNode
  csv: (row: T) => unknown
}

function ReportView<T>({
  rows,
  isLoading,
  columns,
  filename,
  rowKey,
}: {
  rows: Array<T> | undefined
  isLoading: boolean
  columns: Array<Column<T>>
  filename: string
  rowKey: (row: T, i: number) => string
}) {
  const csvColumns: Array<CsvColumn<T>> = columns.map((c) => ({
    header: c.header,
    value: c.csv,
  }))

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {isLoading ? 'Loading…' : `${rows?.length ?? 0} row(s)`}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={(rows?.length ?? 0) === 0}
          onClick={() => downloadCsv(filename, rows ?? [], csvColumns)}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      </div>
      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead
                  key={c.header}
                  className={c.align === 'right' ? 'text-right' : undefined}
                >
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={columns.length}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (rows?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <BarChart3 className="size-8 opacity-40" />
                    No rows for this report.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {rows?.map((row, i) => (
              <TableRow key={rowKey(row, i)}>
                {columns.map((c) => (
                  <TableCell
                    key={c.header}
                    className={c.align === 'right' ? 'text-right' : undefined}
                  >
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

type DateFilters = { from?: string; to?: string; client_id?: string }

// ---------------------------------------------------------------------------
// Individual reports
// ---------------------------------------------------------------------------
function ClientDueReport() {
  const fn = useServerFn(clientDueReportFn)
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'client-due'],
    queryFn: () => fn(),
  })
  return (
    <ReportView
      rows={data}
      isLoading={isLoading}
      filename="client-due-report.csv"
      rowKey={(r) => r.client_id}
      columns={[
        { header: 'Code', cell: (r) => r.client_code, csv: (r) => r.client_code },
        { header: 'Client', cell: (r) => r.name, csv: (r) => r.name },
        {
          header: 'Status',
          cell: (r) => <StatusBadge status={r.status} />,
          csv: (r) => r.status,
        },
        {
          header: 'Billed',
          align: 'right',
          cell: (r) => formatBdt(r.total_billed),
          csv: (r) => r.total_billed,
        },
        {
          header: 'Paid',
          align: 'right',
          cell: (r) => formatBdt(r.total_paid),
          csv: (r) => r.total_paid,
        },
        {
          header: 'Current Due',
          align: 'right',
          cell: (r) => (
            <span className="font-medium">{formatBdt(r.current_due)}</span>
          ),
          csv: (r) => r.current_due,
        },
      ]}
    />
  )
}

function LimitApprovalReport({ filters }: { filters: DateFilters }) {
  const fn = useServerFn(limitApprovalReportFn)
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'limit-approval', filters],
    queryFn: () => fn({ data: filters }),
  })
  return (
    <ReportView
      rows={data}
      isLoading={isLoading}
      filename="limit-approval-report.csv"
      rowKey={(r) => r.id}
      columns={[
        {
          header: 'Number',
          cell: (r) => <span className="font-mono text-xs">{r.request_number}</span>,
          csv: (r) => r.request_number,
        },
        { header: 'Client', cell: (r) => r.client_name ?? '—', csv: (r) => r.client_name },
        { header: 'Account', cell: (r) => r.account_name ?? '—', csv: (r) => r.account_name },
        {
          header: 'Approved USD',
          align: 'right',
          cell: (r) => (r.approved_amount_usd ? formatUsd(r.approved_amount_usd) : '—'),
          csv: (r) => r.approved_amount_usd,
        },
        {
          header: 'Rate',
          align: 'right',
          cell: (r) => r.approved_usd_rate ?? '—',
          csv: (r) => r.approved_usd_rate,
        },
        {
          header: 'BDT Charge',
          align: 'right',
          cell: (r) => (r.bdt_charge ? formatBdt(r.bdt_charge) : '—'),
          csv: (r) => r.bdt_charge,
        },
        {
          header: 'Approved',
          cell: (r) => fmtDate(r.reviewed_at),
          csv: (r) => r.reviewed_at,
        },
      ]}
    />
  )
}

function PaymentCollectionReport({ filters }: { filters: DateFilters }) {
  const fn = useServerFn(paymentCollectionReportFn)
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'payment-collection', filters],
    queryFn: () => fn({ data: filters }),
  })
  return (
    <ReportView
      rows={data}
      isLoading={isLoading}
      filename="payment-collection-report.csv"
      rowKey={(r) => r.id}
      columns={[
        {
          header: 'Number',
          cell: (r) => <span className="font-mono text-xs">{r.payment_number}</span>,
          csv: (r) => r.payment_number,
        },
        { header: 'Client', cell: (r) => r.client_name ?? '—', csv: (r) => r.client_name },
        {
          header: 'Amount',
          align: 'right',
          cell: (r) => <span className="font-medium">{formatBdt(r.amount_bdt)}</span>,
          csv: (r) => r.amount_bdt,
        },
        { header: 'Method', cell: (r) => r.payment_method ?? '—', csv: (r) => r.payment_method },
        {
          header: 'Reference',
          cell: (r) => r.transaction_reference ?? '—',
          csv: (r) => r.transaction_reference,
        },
        {
          header: 'Collected',
          cell: (r) => fmtDate(r.reviewed_at),
          csv: (r) => r.reviewed_at,
        },
      ]}
    />
  )
}

function AdjustmentReport({ filters }: { filters: DateFilters }) {
  const fn = useServerFn(adjustmentReportFn)
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'adjustment', filters],
    queryFn: () => fn({ data: filters }),
  })
  return (
    <ReportView
      rows={data}
      isLoading={isLoading}
      filename="adjustment-report.csv"
      rowKey={(r) => r.id}
      columns={[
        {
          header: 'Number',
          cell: (r) => <span className="font-mono text-xs">{r.adjustment_number}</span>,
          csv: (r) => r.adjustment_number,
        },
        { header: 'Client', cell: (r) => r.client_name ?? '—', csv: (r) => r.client_name },
        {
          header: 'Type',
          cell: (r) => <StatusBadge status={r.type} />,
          csv: (r) => r.type,
        },
        {
          header: 'Amount',
          align: 'right',
          cell: (r) => <span className="font-medium">{formatBdt(r.amount_bdt)}</span>,
          csv: (r) => r.amount_bdt,
        },
        { header: 'Reason', cell: (r) => r.reason, csv: (r) => r.reason },
        { header: 'Date', cell: (r) => fmtDate(r.created_at), csv: (r) => r.created_at },
      ]}
    />
  )
}

function AccountUsageReport() {
  const fn = useServerFn(accountUsageReportFn)
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'account-usage'],
    queryFn: () => fn(),
  })
  return (
    <ReportView
      rows={data}
      isLoading={isLoading}
      filename="ad-account-usage-report.csv"
      rowKey={(r) => r.id}
      columns={[
        { header: 'Code', cell: (r) => r.account_code, csv: (r) => r.account_code },
        { header: 'Account', cell: (r) => r.name, csv: (r) => r.name },
        { header: 'Platform', cell: (r) => r.platform, csv: (r) => r.platform },
        {
          header: 'Status',
          cell: (r) => <StatusBadge status={r.status} />,
          csv: (r) => r.status,
        },
        {
          header: 'Current Limit',
          align: 'right',
          cell: (r) => formatUsd(r.current_limit_usd),
          csv: (r) => r.current_limit_usd,
        },
        {
          header: 'Current Client',
          cell: (r) => r.current_client ?? 'Unassigned',
          csv: (r) => r.current_client,
        },
      ]}
    />
  )
}

function RateUsageReport({ filters }: { filters: DateFilters }) {
  const fn = useServerFn(usdRateUsageReportFn)
  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'rate-usage', filters],
    queryFn: () => fn({ data: filters }),
  })
  return (
    <ReportView
      rows={data}
      isLoading={isLoading}
      filename="usd-rate-usage-report.csv"
      rowKey={(r) => r.rate}
      columns={[
        {
          header: 'USD Rate',
          cell: (r) => <span className="font-medium">{r.rate}</span>,
          csv: (r) => r.rate,
        },
        {
          header: 'Approvals',
          align: 'right',
          cell: (r) => r.approvals,
          csv: (r) => r.approvals,
        },
        {
          header: 'Total USD',
          align: 'right',
          cell: (r) => formatUsd(r.total_usd),
          csv: (r) => r.total_usd,
        },
        {
          header: 'Total BDT',
          align: 'right',
          cell: (r) => formatBdt(r.total_bdt),
          csv: (r) => r.total_bdt,
        },
      ]}
    />
  )
}
