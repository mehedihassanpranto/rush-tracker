import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { BookText } from 'lucide-react'

import { listLedgerFn } from '@/server/ledger/ledger.fns'
import { formatBdt } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
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

export const Route = createFileRoute('/admin/ledger/')({
  component: LedgerPage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function LedgerPage() {
  const listLedger = useServerFn(listLedgerFn)
  const { data: entries, isLoading } = useQuery({
    queryKey: ['ledger'],
    queryFn: () => listLedger(),
  })

  return (
    <div>
      <PageHeader
        title="Ledger"
        description="All financial transactions across clients (most recent first)."
      />

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transaction</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (entries?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <BookText className="size-8 opacity-40" />
                    No ledger entries yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {entries?.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-mono text-xs">
                  {e.transaction_number}
                </TableCell>
                <TableCell>
                  {e.client ? (
                    <Link
                      to="/admin/clients/$clientId"
                      params={{ clientId: e.client.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {e.client.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={e.type} />
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {e.description ?? '—'}
                </TableCell>
                <TableCell className="text-right">
                  {Number(e.debit_bdt) > 0 ? formatBdt(e.debit_bdt) : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {Number(e.credit_bdt) > 0 ? formatBdt(e.credit_bdt) : '—'}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(e.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
