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
import { fetchMetaAdAccountFn } from '@/server/meta/meta.fns'
import { dec, formatBdt, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
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

export const Route = createFileRoute('/admin/ad-accounts/$accountId')({
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
  const queryClient = useQueryClient()
  const getAccount = useServerFn(getAdAccountFn)
  const listHistory = useServerFn(listAssignmentHistoryFn)
  const setStatus = useServerFn(setAdAccountStatusFn)
  const fetchMetaAccount = useServerFn(fetchMetaAdAccountFn)

  const [renameOpen, setRenameOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [metaFetchOpen, setMetaFetchOpen] = useState(false)
  const [spendCapOpen, setSpendCapOpen] = useState(false)

  const { data: account, isLoading } = useQuery({
    queryKey: ['ad-account', accountId],
    queryFn: () => getAccount({ data: { id: accountId } }),
  })

  const { data: history } = useQuery({
    queryKey: ['assignment-history', accountId],
    queryFn: () => listHistory({ data: { ad_account_id: accountId } }),
  })

  const externalAccountId = account?.external_account_id ?? null
  const {
    data: metaLive,
    isLoading: metaLoading,
    isError: metaError,
  } = useQuery({
    queryKey: ['meta-live', externalAccountId],
    queryFn: () =>
      fetchMetaAccount({ data: { external_account_id: externalAccountId! } }),
    enabled: Boolean(externalAccountId),
    retry: false,
  })

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

  if (isLoading || !account) {
    return <Skeleton className="h-64 w-full" />
  }

  const currentClient = account.current_client
  const isAssigned = Boolean(currentClient)

  return (
    <div>
      <Link
        to="/admin/ad-accounts"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Ad Accounts
      </Link>

      <PageHeader title={account.name}>
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
            {account.external_account_id && (
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
        <span className="font-mono text-xs text-muted-foreground">
          {account.account_code}
        </span>
        <StatusBadge status={account.status} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="history">
            Assignment History ({history?.length ?? 0})
          </TabsTrigger>
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
                  label="External ID"
                  value={account.external_account_id}
                />
                <InfoRow
                  label="Current client"
                  value={
                    currentClient ? (
                      <Link
                        to="/admin/clients/$clientId"
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
                      <span className="font-medium">
                        {formatBdt(currentClient.current_due)} due
                      </span>
                    }
                  />
                )}
                <InfoRow
                  label="Current limit"
                  value={
                    <span className="font-medium">
                      {formatUsd(account.current_limit_usd)}
                    </span>
                  }
                />
                <InfoRow
                  label="Per USD"
                  value={
                    Number(account.usd_rate) > 0
                      ? `৳${account.usd_rate} per $1`
                      : null
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
                        <span className="font-medium">
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
                            const low = remaining.lte(LOW_BALANCE_THRESHOLD)
                            return (
                              <span
                                className={
                                  low
                                    ? 'font-medium text-red-600 dark:text-red-400'
                                    : 'font-medium'
                                }
                              >
                                {formatCurrencyAmount(remaining.toFixed(2), metaLive.currency)}
                              </span>
                            )
                          })()
                        )
                      }
                    />
                    <InfoRow label="Spend cap" value={formatCurrencyAmount(metaLive.spend_cap, metaLive.currency)} />
                    <InfoRow
                      label="Balance owed to Meta"
                      value={
                        <span className="font-medium">
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
                  <TableHead>Assigned</TableHead>
                  <TableHead>Released</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(history?.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No assignment history yet.
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {history?.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.client?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      {formatUsd(row.opening_limit_usd)}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.closing_limit_usd
                        ? formatUsd(row.closing_limit_usd)
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
