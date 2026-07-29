import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ArrowLeft, HandCoins, Pencil, Plus, SlidersHorizontal } from 'lucide-react'

import { getClientFn, listClientUsersFn } from '@/server/clients/client.fns'
import { listClientAccountsFn } from '@/server/ad-accounts/assignment.fns'
import {
  clientFinancialsFn,
  listClientLedgerFn,
} from '@/server/ledger/ledger.fns'
import { listAdjustmentsFn } from '@/server/adjustments/adjustment.fns'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { FinancialSummary } from '@/components/shared/financial-summary'
import { LedgerTable } from '@/components/shared/ledger-table'
import { ClientFormDialog } from '@/components/admin/client/client-form-dialog'
import { AssignAccountDialog } from '@/components/admin/client/assign-account-dialog'
import { AddLoginDialog } from '@/components/admin/client/add-login-dialog'
import { CreateAdjustmentDialog } from '@/components/admin/adjustment/create-adjustment-dialog'
import { ReverseDialog } from '@/components/admin/adjustment/reverse-dialog'
import { RequestPaymentDialog } from '@/components/admin/payment/request-payment-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import type { LedgerEntryWithBalance } from '@/types/domain'

export const Route = createFileRoute('/admin/clients/$clientId')({
  component: ClientDetailPage,
})

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2">{value || '—'}</dd>
    </div>
  )
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function ClientDetailPage() {
  const { clientId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const canAdjust = hasPermission(user, PERMISSIONS.ADJUSTMENTS_CREATE)
  const canRequestPayment = hasPermission(
    user,
    PERMISSIONS.PAYMENT_REQUESTS_CREATE,
  )

  const getClient = useServerFn(getClientFn)
  const listAccounts = useServerFn(listClientAccountsFn)
  const listUsers = useServerFn(listClientUsersFn)
  const getFinancials = useServerFn(clientFinancialsFn)
  const listLedger = useServerFn(listClientLedgerFn)
  const listAdjustments = useServerFn(listAdjustmentsFn)

  const [editOpen, setEditOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [requestPayOpen, setRequestPayOpen] = useState(false)
  const [reverseEntry, setReverseEntry] = useState<LedgerEntryWithBalance | null>(
    null,
  )

  const { data: client, isLoading } = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => getClient({ data: { id: clientId } }),
  })
  const { data: financials } = useQuery({
    queryKey: ['client-financials', clientId],
    queryFn: () => getFinancials({ data: { client_id: clientId } }),
  })
  const { data: accounts } = useQuery({
    queryKey: ['client-accounts', clientId],
    queryFn: () => listAccounts({ data: { client_id: clientId } }),
  })
  const { data: users } = useQuery({
    queryKey: ['client-users', clientId],
    queryFn: () => listUsers({ data: { client_id: clientId } }),
  })
  const { data: ledger } = useQuery({
    queryKey: ['client-ledger', clientId],
    queryFn: () => listLedger({ data: { client_id: clientId } }),
  })
  const { data: adjustments } = useQuery({
    queryKey: ['adjustments', clientId],
    queryFn: () => listAdjustments({ data: { client_id: clientId } }),
  })

  if (isLoading || !client) {
    return <Skeleton className="h-64 w-full" />
  }

  return (
    <div>
      <Link
        to="/admin/clients"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Clients
      </Link>

      <PageHeader title={client.name}>
        {canRequestPayment && (
          <Button variant="outline" onClick={() => setRequestPayOpen(true)}>
            <HandCoins className="size-4" />
            Request payment
          </Button>
        )}
        {canAdjust && (
          <Button variant="outline" onClick={() => setAdjustOpen(true)}>
            <SlidersHorizontal className="size-4" />
            Adjustment
          </Button>
        )}
        <Button variant="outline" onClick={() => setEditOpen(true)}>
          <Pencil className="size-4" />
          Edit
        </Button>
      </PageHeader>

      <div className="mb-4 flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {client.client_code}
        </span>
        <StatusBadge status={client.status} />
      </div>

      {financials && (
        <div className="mb-6">
          <FinancialSummary financials={financials} />
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="accounts">
            Ad Accounts ({accounts?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="adjustments">
            Adjustments ({adjustments?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="logins">Logins ({users?.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Client information</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <InfoRow label="Company" value={client.company_name} />
                <InfoRow label="Email" value={client.email} />
                <InfoRow label="Phone" value={client.phone} />
                <InfoRow label="Address" value={client.address} />
                <InfoRow
                  label="USD rate"
                  value={`৳${client.usd_rate} per $1`}
                />
                <InfoRow
                  label="Status"
                  value={<StatusBadge status={client.status} />}
                />
              </dl>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="accounts">
          <div className="mb-3 flex justify-end">
            <Button size="sm" onClick={() => setAssignOpen(true)}>
              <Plus className="size-4" />
              Assign account
            </Button>
          </div>
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Current limit</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(accounts?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No active ad accounts assigned.
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {accounts?.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs">
                      {a.account_code}
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/admin/ad-accounts/$accountId"
                        params={{ accountId: a.id }}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatUsd(a.current_limit_usd)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="ledger">
          <LedgerTable
            entries={ledger ?? []}
            showUsdAmount
            onReverse={canAdjust ? (e) => setReverseEntry(e) : undefined}
          />
        </TabsContent>

        <TabsContent value="adjustments">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(adjustments?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No adjustments.
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {adjustments?.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs">
                      {a.adjustment_number}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={a.type} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatBdt(a.amount_bdt)}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {a.reason}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {fmtDate(a.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="logins">
          <div className="mb-3 flex justify-end">
            <Button size="sm" onClick={() => setLoginOpen(true)}>
              <Plus className="size-4" />
              Add login
            </Button>
          </div>
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Membership</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(users?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={3}>
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No logins yet. Add one so this client can access the
                        portal.
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {users?.map((u) => (
                  <TableRow key={u.user_id}>
                    <TableCell className="font-medium">{u.full_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {u.email}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={u.membership_status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      <ClientFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        client={client}
      />
      <AssignAccountDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        clientId={clientId}
      />
      <AddLoginDialog
        open={loginOpen}
        onOpenChange={setLoginOpen}
        clientId={clientId}
      />
      <CreateAdjustmentDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        fixedClientId={clientId}
      />
      <RequestPaymentDialog
        open={requestPayOpen}
        onOpenChange={setRequestPayOpen}
        fixedClientId={clientId}
      />
      <ReverseDialog
        open={reverseEntry !== null}
        onOpenChange={(o) => !o && setReverseEntry(null)}
        entry={reverseEntry}
        clientId={clientId}
      />
    </div>
  )
}
