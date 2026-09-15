import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import {
  ArrowLeft,
  ArrowLeftRight,
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  Tag,
  UserMinus,
  UserPlus,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  getAdAccountFn,
  listAssignmentHistoryFn,
  setAdAccountStatusFn,
} from '@/server/ad-accounts/ad-account.fns'
import { listAdAccountUsageFn } from '@/server/limit-requests/limit-request.fns'
import {
  fetchMetaAdAccountFn,
  retryMetaSpendCapSyncFn,
  syncAdAccountNameFn,
} from '@/server/meta/meta.fns'
import { dec, formatBdt, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import {
  AccountEditDialog,
  RenameDialog,
  TransferDialog,
} from '@/components/admin/ad-account/account-dialogs'
import { MetaFetchDialog } from '@/components/admin/ad-account/meta-fetch-dialog'
import { MetaSpendCapDialog } from '@/components/admin/ad-account/meta-spend-cap-dialog'
import {
  AssignToClientDialog,
  ReleaseDialog,
} from '@/components/admin/ad-account/assign-release-dialogs'
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

export const Route = createFileRoute('/agency/ad-accounts/$accountId')({
  component: AccountDetailPage,
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

function AccountDetailPage() {
  const { accountId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const canManageMeta = hasPermission(user, PERMISSIONS.AD_ACCOUNTS_MANAGE)
  const queryClient = useQueryClient()
  const getAccount = useServerFn(getAdAccountFn)
  const listHistory = useServerFn(listAssignmentHistoryFn)
  const listUsage = useServerFn(listAdAccountUsageFn)
  const setStatus = useServerFn(setAdAccountStatusFn)
  const fetchMetaAccount = useServerFn(fetchMetaAdAccountFn)
  const retrySpendCapSync = useServerFn(retryMetaSpendCapSyncFn)
  const syncAdAccountName = useServerFn(syncAdAccountNameFn)

  const [renameOpen, setRenameOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [metaFetchOpen, setMetaFetchOpen] = useState(false)
  const [spendCapOpen, setSpendCapOpen] = useState(false)

  const {
    data: account,
    isLoading,
    refetch: refetchAccount,
    isFetching: accountFetching,
  } = useQuery({
    queryKey: ['ad-account', accountId],
    queryFn: () => getAccount({ data: { id: accountId } }),
  })

  const {
    data: history,
    refetch: refetchHistory,
    isFetching: historyFetching,
  } = useQuery({
    queryKey: ['assignment-history', accountId],
    queryFn: () => listHistory({ data: { ad_account_id: accountId } }),
  })

  const {
    data: usage,
    refetch: refetchUsage,
    isFetching: usageFetching,
  } = useQuery({
    queryKey: ['ad-account-usage', accountId],
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
    queryKey: ['meta-live', externalAccountId],
    queryFn: () =>
      fetchMetaAccount({ data: { external_account_id: externalAccountId! } }),
    enabled: canManageMeta && Boolean(externalAccountId),
    retry: false,
  })

  const fetchingAll =
    accountFetching || historyFetching || usageFetching || metaFetching

  // Force-refetches everything shown on this page in one click — our own
  // stored fields, assignment history, usage history, and live Meta data
  // together. Meta failure (e.g. not configured, or this account has no
  // external id) is reported separately rather than failing the whole
  // action, same pattern as the list page's Refresh button. If Meta's live
  // name differs from our stored name, applies it — the daily background
  // sync already does this automatically once a day; this makes it happen
  // immediately on a manual fetch too, instead of the admin having to wait.
  async function handleFetchAll() {
    const results = await Promise.all([
      refetchAccount(),
      refetchHistory(),
      refetchUsage(),
      canManageMeta && externalAccountId
        ? refetchMetaLive()
        : Promise.resolve(null),
    ])
    const accountResult = results[0]
    const metaResult = results[3]
    if (metaResult && metaResult.isError) {
      toast.warning('Fetched, but live Meta data failed to load', {
        description:
          metaResult.error instanceof Error ? metaResult.error.message : undefined,
      })
      return
    }

    const liveName = metaResult?.data?.name
    const storedName = accountResult.data?.name
    if (liveName && storedName && liveName !== storedName) {
      try {
        const syncResult = await syncAdAccountName({
          data: { id: accountId, meta_name: liveName },
        })
        if (syncResult.renamed) {
          await refetchAccount()
          toast.success(`Fetched latest data — renamed to "${liveName}" to match Meta`)
          return
        }
      } catch (err) {
        toast.warning('Fetched latest data, but renaming to match Meta failed', {
          description: err instanceof Error ? err.message : undefined,
        })
        return
      }
    }
    toast.success('Fetched latest data')
  }

  const statusMutation = useMutation({
    mutationFn: (status: 'ACTIVE' | 'INACTIVE') =>
      setStatus({ data: { id: accountId, status } }),
    onSuccess: () => {
      toast.success('Status updated')
      void queryClient.invalidateQueries({ queryKey: ['ad-account', accountId] })
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
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
      void queryClient.invalidateQueries({ queryKey: ['ad-account', accountId] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Retry failed'),
  })

  if (isLoading || !account) {
    return <Skeleton className="h-64 w-full" />
  }

  const currentClient = account.current_client
  const isAssigned = Boolean(currentClient)

  return (
    <div>
      <Link
        to="/agency/ad-accounts"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Ad Accounts
      </Link>

      <PageHeader title={account.name}>
        <Button variant="outline" onClick={() => void handleFetchAll()} disabled={fetchingAll}>
          <RefreshCw className={`size-4 ${fetchingAll ? 'animate-spin' : ''}`} />
          Fetch
        </Button>
        {account.status === 'AVAILABLE' && (
          <Button onClick={() => setAssignOpen(true)}>
            <UserPlus className="size-4" />
            Assign
          </Button>
        )}
        {isAssigned && (
          <Button variant="outline" onClick={() => setTransferOpen(true)}>
            <ArrowLeftRight className="size-4" />
            Transfer
          </Button>
        )}
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
            {canManageMeta && account.external_account_id && (
              <DropdownMenuItem onSelect={() => setMetaFetchOpen(true)}>
                <RefreshCw className="size-4" />
                Fetch from Meta
              </DropdownMenuItem>
            )}
            {isAssigned && account.status === 'ACTIVE' && (
              <DropdownMenuItem onSelect={() => statusMutation.mutate('INACTIVE')}>
                <PowerOff className="size-4" />
                Deactivate
              </DropdownMenuItem>
            )}
            {isAssigned && account.status === 'INACTIVE' && (
              <DropdownMenuItem onSelect={() => statusMutation.mutate('ACTIVE')}>
                <Power className="size-4" />
                Activate
              </DropdownMenuItem>
            )}
            {isAssigned && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setReleaseOpen(true)}
                >
                  <UserMinus className="size-4" />
                  Release
                </DropdownMenuItem>
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
          {canManageMeta && (
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
          )}
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
                  label="Source"
                  value={
                    <Badge variant={account.is_platform ? 'secondary' : 'outline'}>
                      {account.is_platform ? 'Platform assigned' : 'Own'}
                    </Badge>
                  }
                />
                <InfoRow
                  label="Ad account ID"
                  value={account.external_account_id}
                />
                <InfoRow
                  label="Current client"
                  value={
                    currentClient ? (
                      <Link
                        to="/agency/clients/$clientId"
                        params={{ clientId: currentClient.id }}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {currentClient.name} ({currentClient.client_code})
                      </Link>
                    ) : (
                      'Unassigned'
                    )
                  }
                />
                {currentClient && (
                  <InfoRow
                    label="Current balance"
                    value={
                      <span className="num font-medium">
                        {formatBdt(currentClient.current_due)} due
                      </span>
                    }
                  />
                )}
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
                    // Mirrors adAccountUsdRate() (rate.service.ts): the
                    // account's own rate wins when set; a zero/unset rate
                    // falls back to whichever client currently holds it.
                    (() => {
                      const ownRate = Number(account.usd_rate) > 0
                      const rate = ownRate
                        ? account.usd_rate
                        : currentClient && Number(currentClient.usd_rate) > 0
                          ? currentClient.usd_rate
                          : null
                      if (rate == null) return null
                      return (
                        <span className={`num ${ownRate ? '' : 'italic'}`}>
                          ৳{rate} per $1{ownRate ? '' : ' (from client)'}
                        </span>
                      )
                    })()
                  }
                />
                <InfoRow
                  label="Status"
                  value={<StatusBadge status={account.status} />}
                />
              </dl>
            </CardContent>
          </Card>

          {canManageMeta && externalAccountId && (
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
                            // Flat USD-scale threshold, no FX conversion —
                            // same gate as the list page's bell/Meta Due.
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
                {history?.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.client?.name ?? '—'}</TableCell>
                    <TableCell className="num text-right">
                      {formatUsd(row.opening_limit_usd)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {row.closing_limit_usd
                        ? formatUsd(row.closing_limit_usd)
                        : '—'}
                    </TableCell>
                    <TableCell className="num text-right font-medium">
                      {row.closing_limit_usd
                        ? formatUsd(
                            dec(row.closing_limit_usd)
                              .minus(dec(row.opening_limit_usd))
                              .toFixed(2),
                          )
                        : '—'}
                    </TableCell>
                    <TableCell>{fmtDate(row.assigned_at)}</TableCell>
                    <TableCell>{fmtDate(row.released_at)}</TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
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
                across all clients that have held it.
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
                {usage?.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.client?.name ?? '—'}</TableCell>
                    <TableCell>{fmtDate(row.approved_at)}</TableCell>
                    <TableCell className="num text-right">
                      {formatUsd(row.opening_balance_usd)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {formatUsd(row.requested_amount_usd)}
                    </TableCell>
                    <TableCell className="num text-right font-medium">
                      {formatUsd(row.approved_amount_usd ?? 0)}
                    </TableCell>
                    <TableCell className="num text-right">
                      {row.approved_new_limit_usd
                        ? formatUsd(row.approved_new_limit_usd)
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        account={account}
      />
      <AccountEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        account={account}
      />
      <AssignToClientDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        account={account}
      />
      <ReleaseDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        account={account}
      />
      <TransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        account={account}
        currentClientId={currentClient?.id ?? null}
      />
      <MetaFetchDialog
        open={metaFetchOpen}
        onOpenChange={setMetaFetchOpen}
        accountId={account.id}
        externalAccountId={account.external_account_id}
        currentLimitUsd={account.current_limit_usd}
      />
      <MetaSpendCapDialog
        open={spendCapOpen}
        onOpenChange={setSpendCapOpen}
        accountId={account.id}
        externalAccountId={account.external_account_id}
      />
    </div>
  )
}
