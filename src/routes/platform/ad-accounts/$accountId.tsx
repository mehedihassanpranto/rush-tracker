import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import {
  ArrowLeft,
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  Tag,
  UserMinus,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  fetchPoolAccountMetaFn,
  getPoolAccountFn,
  grantPoolAccountFn,
  listPoolAccountHistoryFn,
  listPoolAccountUsageFn,
  retryPoolAccountSpendCapSyncFn,
  setPoolAccountStatusFn,
} from '@/server/platform/pool.fns'
import { listOrganizationsFn } from '@/server/organizations/organization.fns'
import { dec, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import {
  PoolEditDialog,
  PoolRenameDialog,
} from '@/components/platform/ad-accounts/pool-account-dialogs'
import { PoolSpendCapDialog } from '@/components/platform/ad-accounts/pool-spend-cap-dialog'
import { RevokeGrantDialog } from '@/components/platform/organizations/revoke-grant-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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

export const Route = createFileRoute('/platform/ad-accounts/$accountId')({
  component: PoolAccountDetailPage,
})

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2">{value || '—'}</dd>
    </div>
  )
}

function fmtDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function PoolAccountDetailPage() {
  const { accountId } = Route.useParams()
  const queryClient = useQueryClient()
  const getAccount = useServerFn(getPoolAccountFn)
  const listHistory = useServerFn(listPoolAccountHistoryFn)
  const listUsage = useServerFn(listPoolAccountUsageFn)
  const listOrganizations = useServerFn(listOrganizationsFn)
  const setStatus = useServerFn(setPoolAccountStatusFn)
  const fetchMetaAccount = useServerFn(fetchPoolAccountMetaFn)
  const retrySpendCapSync = useServerFn(retryPoolAccountSpendCapSyncFn)
  const grant = useServerFn(grantPoolAccountFn)

  const [renameOpen, setRenameOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [spendCapOpen, setSpendCapOpen] = useState(false)
  const [toRevoke, setToRevoke] = useState<{
    adAccountId: string
    accountLabel: string
    agencyName: string
  } | null>(null)

  const {
    data: row,
    isLoading,
    refetch: refetchAccount,
    isFetching: accountFetching,
  } = useQuery({
    queryKey: ['pool-account', accountId],
    queryFn: () => getAccount({ data: { id: accountId } }),
  })
  const account = row?.account

  const { data: organizations } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => listOrganizations(),
  })

  const {
    data: history,
    refetch: refetchHistory,
    isFetching: historyFetching,
  } = useQuery({
    queryKey: ['pool-account-history', accountId],
    queryFn: () => listHistory({ data: { ad_account_id: accountId } }),
  })

  const {
    data: usage,
    refetch: refetchUsage,
    isFetching: usageFetching,
  } = useQuery({
    queryKey: ['pool-account-usage', accountId],
    queryFn: () => listUsage({ data: { ad_account_id: accountId } }),
  })
  const totalUsage = (usage ?? []).reduce(
    (sum, r) => sum.plus(dec(r.approved_amount_usd ?? 0)),
    dec(0),
  )

  const externalAccountId = account?.external_account_id ?? null
  const {
    data: metaLive,
    isLoading: metaLoading,
    isError: metaError,
    refetch: refetchMetaLive,
    isFetching: metaFetching,
  } = useQuery({
    queryKey: ['pool-account-meta-live', accountId],
    queryFn: () => fetchMetaAccount({ data: { id: accountId } }),
    enabled: Boolean(externalAccountId),
    retry: false,
  })

  const fetchingAll =
    accountFetching || historyFetching || usageFetching || metaFetching

  async function handleFetchAll() {
    await Promise.all([
      refetchAccount(),
      refetchHistory(),
      refetchUsage(),
      externalAccountId ? refetchMetaLive() : Promise.resolve(null),
    ])
    toast.success('Fetched latest data')
  }

  const statusMutation = useMutation({
    mutationFn: (status: 'ACTIVE' | 'INACTIVE') =>
      setStatus({ data: { id: accountId, status } }),
    onSuccess: () => {
      toast.success('Status updated')
      void queryClient.invalidateQueries({ queryKey: ['pool-account', accountId] })
      void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const retrySyncMutation = useMutation({
    mutationFn: () => retrySpendCapSync({ data: { id: accountId } }),
    onSuccess: (updated) => {
      if (updated.meta_sync_pending) {
        toast.warning('Retried, but still out of sync', {
          description: updated.meta_sync_error ?? undefined,
        })
      } else {
        toast.success('Spend cap synced with Meta')
      }
      void queryClient.invalidateQueries({ queryKey: ['pool-account', accountId] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Retry failed'),
  })

  const grantMutation = useMutation({
    mutationFn: (organizationId: string) =>
      grant({ data: { ad_account_id: accountId, organization_id: organizationId } }),
    onSuccess: () => {
      toast.success('Account granted')
      void queryClient.invalidateQueries({ queryKey: ['pool-account', accountId] })
      void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to grant'),
  })

  if (isLoading || !account || !row) {
    return <Skeleton className="h-64 w-full" />
  }

  const grantedTo = row.granted_to

  return (
    <div>
      <Link
        to="/platform/ad-accounts"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Ad Account Pool
      </Link>

      <PageHeader title={account.name}>
        <Button variant="outline" onClick={() => void handleFetchAll()} disabled={fetchingAll}>
          <RefreshCw className={`size-4 ${fetchingAll ? 'animate-spin' : ''}`} />
          Fetch
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <Tag className="size-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              Edit details
            </DropdownMenuItem>
            {account.status === 'ACTIVE' && (
              <DropdownMenuItem onSelect={() => statusMutation.mutate('INACTIVE')}>
                <PowerOff className="size-4" />
                Deactivate
              </DropdownMenuItem>
            )}
            {account.status === 'INACTIVE' && (
              <DropdownMenuItem onSelect={() => statusMutation.mutate('ACTIVE')}>
                <Power className="size-4" />
                Activate
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {grantedTo ? (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  setToRevoke({
                    adAccountId: account.id,
                    accountLabel: `${account.account_code} "${account.name}"`,
                    agencyName: grantedTo.name,
                  })
                }
              >
                <UserMinus className="size-4" />
                Revoke from {grantedTo.name}
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuLabel>Grant to</DropdownMenuLabel>
                {(organizations ?? []).map((org) => (
                  <DropdownMenuItem
                    key={org.id}
                    disabled={grantMutation.isPending}
                    onSelect={() => grantMutation.mutate(org.id)}
                  >
                    {org.name}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      <div className="mb-4 flex items-center gap-3">
        <span className="num text-xs text-muted-foreground">
          {account.account_code}
        </span>
        <StatusBadge status={account.status} />
      </div>

      {account.meta_sync_pending && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
          <div>
            <p className="font-medium text-red-700 dark:text-red-400">
              Spend cap out of sync with Meta
            </p>
            <p className="text-red-600 dark:text-red-400">
              {account.meta_sync_error ??
                'The last automatic sync attempt failed.'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => retrySyncMutation.mutate()}
            disabled={retrySyncMutation.isPending}
          >
            <RefreshCw
              className={`size-4 ${retrySyncMutation.isPending ? 'animate-spin' : ''}`}
            />
            Retry sync
          </Button>
        </div>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="history">
            Assignment History ({history?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="usage">Usage ({usage?.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <InfoRow label="Account code" value={account.account_code} />
                <InfoRow label="Platform" value={account.platform} />
                <InfoRow
                  label="Ad account ID"
                  value={account.external_account_id}
                />
                <InfoRow
                  label="Assigned agency"
                  value={
                    grantedTo ? (
                      <Link
                        to="/platform/organizations/$organizationId"
                        params={{ organizationId: grantedTo.organization_id }}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {grantedTo.name}
                      </Link>
                    ) : (
                      <Badge variant="secondary">Unassigned</Badge>
                    )
                  }
                />
                <InfoRow
                  label="Current limit"
                  value={
                    <span className="num font-medium">
                      {formatUsd(account.current_limit_usd)}
                    </span>
                  }
                />
                <InfoRow
                  label="Threshold"
                  value={
                    Number(account.threshold_usd) > 0 ? (
                      <span className="num font-medium">
                        {formatUsd(account.threshold_usd)}
                      </span>
                    ) : null
                  }
                />
                <InfoRow
                  label="Per USD"
                  value={
                    Number(account.usd_rate) > 0 ? (
                      <span className="num">৳{account.usd_rate} per $1</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Inherits the holding client's own rate
                      </span>
                    )
                  }
                />
                <InfoRow
                  label="Status"
                  value={<StatusBadge status={account.status} />}
                />
              </dl>
            </CardContent>
          </Card>

          {externalAccountId && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="text-base">Meta live data</CardTitle>
                <CardAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSpendCapOpen(true)}
                  >
                    <Pencil className="size-4" />
                    Edit spend cap
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                {metaLoading && <Skeleton className="h-16 w-full" />}
                {metaError && (
                  <p className="text-sm text-muted-foreground">
                    Unable to load live data from Meta right now.
                  </p>
                )}
                {metaLive && (
                  <dl className="divide-y">
                    <InfoRow
                      label="Amount spent"
                      value={
                        <span className="num font-medium">
                          {formatCurrencyAmount(metaLive.amount_spent, metaLive.currency)}
                        </span>
                      }
                    />
                    <InfoRow
                      label="Remaining"
                      value={
                        metaLive.spend_cap == null ? (
                          'No spend cap set'
                        ) : (
                          (() => {
                            const remaining = dec(metaLive.spend_cap).minus(
                              dec(metaLive.amount_spent ?? 0),
                            )
                            const low =
                              metaLive.currency === 'USD' &&
                              remaining.lte(LOW_BALANCE_THRESHOLD)
                            return (
                              <span
                                className={
                                  low
                                    ? 'num font-medium text-danger'
                                    : 'num font-medium'
                                }
                              >
                                {formatCurrencyAmount(remaining.toFixed(2), metaLive.currency)}
                              </span>
                            )
                          })()
                        )
                      }
                    />
                    <InfoRow
                      label="Spend cap"
                      value={
                        <span className="num">
                          {formatCurrencyAmount(metaLive.spend_cap, metaLive.currency)}
                        </span>
                      }
                    />
                    <InfoRow
                      label="Balance owed to Meta"
                      value={
                        <span className="num font-medium">
                          {formatCurrencyAmount(metaLive.meta_balance, metaLive.currency)}
                        </span>
                      }
                    />
                    <InfoRow label="Currency" value={metaLive.currency} />
                  </dl>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="history">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Opening</TableHead>
                  <TableHead className="text-right">Closing</TableHead>
                  <TableHead className="text-right">Spent Amount</TableHead>
                  <TableHead>Assigned</TableHead>
                  <TableHead>Released</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(history?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No assignment history yet.
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {history?.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{h.client?.name ?? '—'}</TableCell>
                    <TableCell className="num text-right">
                      {formatUsd(h.opening_limit_usd)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {h.closing_limit_usd ? formatUsd(h.closing_limit_usd) : '—'}
                    </TableCell>
                    <TableCell className="num text-right font-medium">
                      {h.closing_limit_usd
                        ? formatUsd(
                            dec(h.closing_limit_usd)
                              .minus(dec(h.opening_limit_usd))
                              .toFixed(2),
                          )
                        : '—'}
                    </TableCell>
                    <TableCell>{fmtDate(h.assigned_at)}</TableCell>
                    <TableCell>{fmtDate(h.released_at)}</TableCell>
                    <TableCell>
                      <StatusBadge status={h.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="usage">
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="text-base">Total USD used</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="num text-2xl font-semibold">
                {formatUsd(totalUsage.toFixed(2))}
              </p>
              <p className="text-sm text-muted-foreground">
                Sum of every approved limit request against this account,
                across every agency and client that has ever held it.
              </p>
            </CardContent>
          </Card>

          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Approved</TableHead>
                  <TableHead className="text-right">Opening balance</TableHead>
                  <TableHead className="text-right">Requested</TableHead>
                  <TableHead className="text-right">Approved amount</TableHead>
                  <TableHead className="text-right">New limit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(usage?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No approved limit requests yet.
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {usage?.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.client?.name ?? '—'}</TableCell>
                    <TableCell>{fmtDate(u.approved_at)}</TableCell>
                    <TableCell className="num text-right">
                      {formatUsd(u.opening_balance_usd)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {formatUsd(u.requested_amount_usd)}
                    </TableCell>
                    <TableCell className="num text-right font-medium">
                      {formatUsd(u.approved_amount_usd ?? 0)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {u.approved_new_limit_usd ? formatUsd(u.approved_new_limit_usd) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      <PoolRenameDialog open={renameOpen} onOpenChange={setRenameOpen} account={account} />
      <PoolEditDialog open={editOpen} onOpenChange={setEditOpen} account={account} />
      <PoolSpendCapDialog
        open={spendCapOpen}
        onOpenChange={setSpendCapOpen}
        accountId={account.id}
        accountLabel={`${account.account_code} "${account.name}"`}
        currentLimitUsd={account.current_limit_usd}
      />
      <RevokeGrantDialog
        grant={toRevoke}
        open={toRevoke !== null}
        onOpenChange={(o) => !o && setToRevoke(null)}
      />
    </div>
  )
}
