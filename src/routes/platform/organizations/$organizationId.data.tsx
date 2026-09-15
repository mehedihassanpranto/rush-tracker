import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ArrowLeft, Eye } from 'lucide-react'

import { getAgencySupportDataFn } from '@/server/organizations/organization.fns'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatBdt, formatUsd } from '@/lib/money/money'

/**
 * Support view onto one agency's real books. Read-only, and every open is
 * recorded in THAT AGENCY'S OWN audit log — see getAgencySupportDataFn.
 */
export const Route = createFileRoute(
  '/platform/organizations/$organizationId/data',
)({
  component: AgencyDataPage,
})

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function AgencyDataPage() {
  const { organizationId } = Route.useParams()
  const getData = useServerFn(getAgencySupportDataFn)

  // Fetched once per visit: each call writes an access record into the
  // agency's audit log, so background refetching would inflate it with
  // accesses nobody actually made.
  const { data, isLoading } = useQuery({
    queryKey: ['agency-support-data', organizationId],
    queryFn: () => getData({ data: { id: organizationId } }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />

  const { organization, clients, adAccounts, ledger } = data

  return (
    <div>
      <Link
        to="/platform/organizations/$organizationId"
        params={{ organizationId }}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {organization.name}
      </Link>

      <PageHeader
        title={`${organization.name} — agency data`}
        description="Read-only support view of this agency's own records."
      />

      <div className="mb-6 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
        <Eye className="mt-0.5 size-4 shrink-0" />
        <p>
          This is a customer's own business data. Opening this page is recorded
          in <strong>{organization.name}'s</strong> audit log, where their own
          admins can see it. Nothing here can be edited.
        </p>
      </div>

      <Card className="mb-4 overflow-x-auto p-0">
        <CardHeader className="px-6 pt-6">
          <CardTitle className="text-base">Clients ({clients.length})</CardTitle>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-6">Current due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  No clients.
                </TableCell>
              </TableRow>
            )}
            {clients.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="pl-6 font-mono text-xs">{c.client_code}</TableCell>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>
                  <StatusBadge status={c.status} />
                </TableCell>
                <TableCell className="num pr-6">{formatBdt(c.current_due)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="mb-4 overflow-x-auto p-0">
        <CardHeader className="px-6 pt-6">
          <CardTitle className="text-base">
            Ad accounts ({adAccounts.length})
          </CardTitle>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-6">Current limit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adAccounts.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  No ad accounts.
                </TableCell>
              </TableRow>
            )}
            {adAccounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="pl-6 font-mono text-xs">{a.account_code}</TableCell>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell>
                  <Badge variant={a.is_platform ? 'secondary' : 'outline'}>
                    {a.is_platform ? 'Platform assigned' : 'Own'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <StatusBadge status={a.status} />
                </TableCell>
                <TableCell className="num pr-6">
                  {formatUsd(a.current_limit_usd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="overflow-x-auto p-0">
        <CardHeader className="px-6 pt-6">
          <CardTitle className="text-base">
            Ledger — most recent {ledger.length}
          </CardTitle>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Txn</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Debit</TableHead>
              <TableHead className="pr-6">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ledger.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  No ledger entries.
                </TableCell>
              </TableRow>
            )}
            {ledger.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="pl-6 font-mono text-xs">
                  {l.transaction_number}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {fmtDateTime(l.created_at)}
                </TableCell>
                <TableCell className="text-sm">{l.client_name ?? '—'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{l.type}</TableCell>
                <TableCell className="num">
                  {Number(l.debit_bdt) > 0 ? formatBdt(l.debit_bdt) : '—'}
                </TableCell>
                <TableCell className="num pr-6 text-success">
                  {Number(l.credit_bdt) > 0 ? formatBdt(l.credit_bdt) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
