import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import {
  ArrowLeft,
  Bell,
  HandCoins,
  MoreHorizontal,
  Pencil,
  Plus,
  SlidersHorizontal,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  getClientFn,
  listClientUsersFn,
  setClientMembershipStatusFn,
} from '@/server/clients/client.fns'
import type { ClientUserRow } from '@/server/clients/client.fns'
import { listClientAccountsFn } from '@/server/ad-accounts/assignment.fns'
import {
  clientFinancialsFn,
  listClientLedgerFn,
} from '@/server/ledger/ledger.fns'
import { listAdjustmentsFn } from '@/server/adjustments/adjustment.fns'
import { listClientLimitRequestsFn } from '@/server/limit-requests/limit-request.fns'
import { listUsableMetaAdAccountsFn } from '@/server/meta/meta.fns'
import { dec, formatBdt, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD, META_DUE_THRESHOLD } from '@/lib/meta/thresholds'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { FinancialSummary } from '@/components/shared/financial-summary'
import { LedgerTable } from '@/components/shared/ledger-table'
import { ClientFormDialog } from '@/components/admin/client/client-form-dialog'
import { AssignAccountDialog } from '@/components/admin/client/assign-account-dialog'
import { AddLoginDialog } from '@/components/admin/client/add-login-dialog'
import { EditLoginDialog } from '@/components/admin/client/edit-login-dialog'
import { CreateAdjustmentDialog } from '@/components/admin/adjustment/create-adjustment-dialog'
import { ReverseDialog } from '@/components/admin/adjustment/reverse-dialog'
import { RequestPaymentDialog } from '@/components/admin/payment/request-payment-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { LedgerEntryWithBalance } from '@/types/domain'

export const Route = createFileRoute('/agency/clients/$clientId')({
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

/** "08:00pm, 7 april 2026" — approval-time format for the Limit Requests tab. */
function fmtApprovalDateTime(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  let hours = d.getHours()
  const ampm = hours >= 12 ? 'pm' : 'am'
  hours = hours % 12 || 12
  const hh = String(hours).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const month = d
    .toLocaleDateString(undefined, { month: 'long' })
    .toLowerCase()
  return `${hh}:${mm}${ampm}, ${d.getDate()} ${month} ${d.getFullYear()}`
}

function ClientDetailPage() {
  const { clientId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const canAdjust = hasPermission(user, PERMISSIONS.ADJUSTMENTS_CREATE)
  const canRequestPayment = hasPermission(
    user,
    PERMISSIONS.PAYMENT_REQUESTS_CREATE,
  )
  const canManageMeta = hasPermission(user, PERMISSIONS.AD_ACCOUNTS_MANAGE)

  const queryClient = useQueryClient()
  const getClient = useServerFn(getClientFn)
  const listAccounts = useServerFn(listClientAccountsFn)
  const listMetaAccounts = useServerFn(listUsableMetaAdAccountsFn)
  const listUsers = useServerFn(listClientUsersFn)
  const getFinancials = useServerFn(clientFinancialsFn)
  const listLedger = useServerFn(listClientLedgerFn)
  const listAdjustments = useServerFn(listAdjustmentsFn)
  const listLimitRequests = useServerFn(listClientLimitRequestsFn)
  const setMembershipStatus = useServerFn(setClientMembershipStatusFn)

  const [editOpen, setEditOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [requestPayOpen, setRequestPayOpen] = useState(false)
  const [editLoginTarget, setEditLoginTarget] = useState<ClientUserRow | null>(
    null,
  )
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

  // Same bulk Meta fetch that powers the ad accounts list page's
  // Remaining/Meta Due columns (two Graph API calls total, not one per
  // row) — errors just mean those columns show '—', never break the page.
  const { data: metaAccounts } = useQuery({
    queryKey: ['meta-usable-ad-accounts'],
    queryFn: () => listMetaAccounts(),
    enabled: canManageMeta,
    staleTime: 2 * 60 * 1000,
    retry: false,
    throwOnError: false,
  })
  const balanceByAccountId = new Map<
    string,
    { remaining: string | null; low: boolean; metaDue: string | null; metaDueHigh: boolean; currency: string }
  >()
  for (const m of metaAccounts ?? []) {
    if (!m.linked_account_id) continue
    const isUsd = m.currency === 'USD'
    const remaining =
      m.spend_cap != null ? dec(m.spend_cap).minus(dec(m.amount_spent ?? 0)) : null
    balanceByAccountId.set(m.linked_account_id, {
      remaining: remaining ? remaining.toFixed(2) : null,
      low: isUsd && remaining ? remaining.lte(LOW_BALANCE_THRESHOLD) : false,
      metaDue: m.meta_balance,
      metaDueHigh:
        isUsd && m.meta_balance != null && dec(m.meta_balance).gte(META_DUE_THRESHOLD),
      currency: m.currency ?? '',
    })
  }
  // Sum of Meta spend headroom across this client's own linked accounts,
  // USD only (no FX path, same gate as the Remaining column/bell). `null`
  // while Meta data hasn't loaded (or isn't permitted) so the summary card
  // hides instead of showing a misleading "$0.00".
  const totalRemainingUsd =
    canManageMeta && metaAccounts !== undefined
      ? (accounts ?? [])
          .reduce((sum, a) => {
            const balance = balanceByAccountId.get(a.id)
            if (!balance || balance.remaining == null || balance.currency !== 'USD') {
              return sum
            }
            return sum.plus(dec(balance.remaining))
          }, dec(0))
          .toFixed(2)
      : null
  // Sum of Meta Due across this client's own linked accounts, same USD-only
  // gate as totalRemainingUsd above.
  const totalMetaDueUsd =
    canManageMeta && metaAccounts !== undefined
      ? (accounts ?? [])
          .reduce((sum, a) => {
            const balance = balanceByAccountId.get(a.id)
            if (!balance || balance.metaDue == null || balance.currency !== 'USD') {
              return sum
            }
            return sum.plus(dec(balance.metaDue))
          }, dec(0))
          .toFixed(2)
      : null
  const { data: users } = useQuery({
    queryKey: ['client-users', clientId],
    queryFn: () => listUsers({ data: { client_id: clientId } }),
  })
  const membershipStatusMutation = useMutation({
    mutationFn: (input: { user_id: string; status: 'ACTIVE' | 'INACTIVE' }) =>
      setMembershipStatus({ data: { ...input, client_id: clientId } }),
    onSuccess: () => {
      toast.success('Membership status updated')
      void queryClient.invalidateQueries({ queryKey: ['client-users', clientId] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })
  const { data: ledger } = useQuery({
    queryKey: ['client-ledger', clientId],
    queryFn: () => listLedger({ data: { client_id: clientId } }),
  })
  const { data: adjustments } = useQuery({
    queryKey: ['adjustments', clientId],
    queryFn: () => listAdjustments({ data: { client_id: clientId } }),
  })
  const { data: limitRequests } = useQuery({
    queryKey: ['client-limit-requests', clientId],
    queryFn: () => listLimitRequests({ data: { client_id: clientId } }),
  })

  if (isLoading || !client) {
    return <Skeleton className="h-64 w-full" />
  }

  return (
    <div>
      <Link
        to="/agency/clients"
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
          <FinancialSummary
            financials={financials}
            totalRemainingUsd={totalRemainingUsd}
            totalMetaDueUsd={totalMetaDueUsd}
          />
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
          <TabsTrigger value="limit-requests">
            Limit Requests ({limitRequests?.length ?? 0})
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
                  <TableHead className="text-right">Current balance</TableHead>
                  <TableHead className="text-right">Per USD</TableHead>
                  <TableHead className="text-right">Current limit</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="text-right">Meta Due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(accounts?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No active ad accounts assigned.
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {accounts?.map((a) => {
                  const balance = balanceByAccountId.get(a.id)
                  return (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs">
                      {a.account_code}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Link
                          to="/agency/ad-accounts/$accountId"
                          params={{ accountId: a.id }}
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {a.name}
                        </Link>
                        {balance?.low && (
                          <span
                            title={`Low remaining Meta balance: ${balance.remaining} ${balance.currency}`}
                          >
                            <Bell className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
                          </span>
                        )}
                        {balance?.metaDueHigh && (
                          <span
                            className="flex shrink-0 -space-x-1.5"
                            title={`High balance owed to Meta: ${balance.metaDue} ${balance.currency}`}
                          >
                            <Bell className="size-3.5 text-red-600 dark:text-red-400" />
                            <Bell className="size-3.5 text-red-600 dark:text-red-400" />
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {a.current_client
                        ? formatBdt(a.current_client.current_due)
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {(() => {
                        // Mirrors adAccountUsdRate() (rate.service.ts): the
                        // account's own rate wins when set; a zero/unset
                        // rate falls back to this client's own rate.
                        const ownRate = Number(a.usd_rate) > 0
                        const rate = ownRate
                          ? a.usd_rate
                          : Number(client?.usd_rate) > 0
                            ? client?.usd_rate
                            : null
                        if (rate == null) return '—'
                        return <span className={ownRate ? '' : 'italic'}>৳{rate}</span>
                      })()}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatUsd(a.current_limit_usd)}
                    </TableCell>
                    <TableCell
                      className={`text-right ${balance?.low ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
                    >
                      {balance ? formatCurrencyAmount(balance.remaining, balance.currency) : '—'}
                    </TableCell>
                    <TableCell
                      className={`text-right ${balance?.metaDueHigh ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
                    >
                      {balance ? formatCurrencyAmount(balance.metaDue, balance.currency) : '—'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
                    </TableCell>
                  </TableRow>
                  )
                })}
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

        <TabsContent value="limit-requests">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">USD</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(limitRequests?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={3}>
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No approved limit requests yet.
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {limitRequests?.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      {r.ad_account ? (
                        <Link
                          to="/agency/ad-accounts/$accountId"
                          params={{ accountId: r.ad_account.id }}
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {r.ad_account.name}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatUsd(r.approved_amount_usd ?? 0)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {fmtApprovalDateTime(r.approved_at)}
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
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(users?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>
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
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditLoginTarget(u)}>
                            Edit profile
                          </DropdownMenuItem>
                          {u.membership_status === 'ACTIVE' ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                membershipStatusMutation.mutate({
                                  user_id: u.user_id,
                                  status: 'INACTIVE',
                                })
                              }
                            >
                              Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onSelect={() =>
                                membershipStatusMutation.mutate({
                                  user_id: u.user_id,
                                  status: 'ACTIVE',
                                })
                              }
                            >
                              Activate
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
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
      <EditLoginDialog
        open={editLoginTarget !== null}
        onOpenChange={(o) => !o && setEditLoginTarget(null)}
        clientId={clientId}
        login={editLoginTarget}
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
