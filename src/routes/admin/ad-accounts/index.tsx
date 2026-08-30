import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Bell, Download, Megaphone, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { listAdAccountsFn } from '@/server/ad-accounts/ad-account.fns'
import { listMetaBusinessAdAccountsFn, syncAdAccountNameFn } from '@/server/meta/meta.fns'
import { dec, formatBdt, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD, META_DUE_THRESHOLD } from '@/lib/meta/thresholds'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { railClassName, type RailHealth } from '@/components/shared/status-rail'
import { AccountCreateDialog } from '@/components/admin/ad-account/account-dialogs'
import { MetaImportDialog } from '@/components/admin/ad-account/meta-import-dialog'
import { Button } from '@/components/ui/button'
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

export const Route = createFileRoute('/admin/ad-accounts/')({
  component: AdAccountsPage,
})

function AdAccountsPage() {
  const { user } = Route.useRouteContext()
  const canManageMeta = hasPermission(user, PERMISSIONS.AD_ACCOUNTS_MANAGE)
  const listAccounts = useServerFn(listAdAccountsFn)
  const listMetaAccounts = useServerFn(listMetaBusinessAdAccountsFn)
  const syncAdAccountName = useServerFn(syncAdAccountNameFn)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const {
    data: accounts,
    isLoading,
    refetch: refetchAccounts,
    isFetching: accountsFetching,
  } = useQuery({
    queryKey: ['ad-accounts'],
    queryFn: () => listAccounts(),
  })

  // Reuses the same bulk Meta fetch that powers "Import from Meta" (two
  // Graph API calls total, not one per row) — errors (e.g. Meta not
  // configured) just mean no bells show, never break the list. Gated on
  // ad_accounts.manage client-side too, matching the server guard — a
  // view-only admin would otherwise get a silent FORBIDDEN that looks like
  // a Meta outage instead of just not seeing Meta-only data.
  const {
    data: metaAccounts,
    refetch: refetchMeta,
    isFetching: metaFetching,
  } = useQuery({
    queryKey: ['meta-business-ad-accounts'],
    queryFn: () => listMetaAccounts(),
    enabled: canManageMeta,
    staleTime: 2 * 60 * 1000,
    retry: false,
    throwOnError: false,
  })

  const refreshing = accountsFetching || metaFetching

  // If Meta's live name differs from our stored name for any linked
  // account, apply it — same safe, non-financial auto-rename the daily
  // background sync already does, just immediate instead of once a day.
  async function syncRenamedAccounts(
    accounts: Array<{ id: string; name: string }>,
    metaAccounts: Array<{ linked_account_id: string | null; name: string }>,
  ): Promise<number> {
    const nameByAccountId = new Map(accounts.map((a) => [a.id, a.name]))
    const mismatches = metaAccounts.filter(
      (m) =>
        m.linked_account_id &&
        m.name &&
        nameByAccountId.get(m.linked_account_id) !== m.name,
    )
    if (mismatches.length === 0) return 0

    const results = await Promise.allSettled(
      mismatches.map((m) =>
        syncAdAccountName({
          data: { id: m.linked_account_id!, meta_name: m.name },
        }),
      ),
    )
    return results.filter(
      (r) => r.status === 'fulfilled' && r.value.renamed,
    ).length
  }

  async function handleRefresh() {
    const [accountsResult, metaResult] = await Promise.all([
      refetchAccounts(),
      refetchMeta(),
    ])
    if (metaResult.isError) {
      toast.warning('Refreshed, but live Meta data failed to load', {
        description:
          metaResult.error instanceof Error ? metaResult.error.message : undefined,
      })
      return
    }

    const renamedCount = await syncRenamedAccounts(
      accountsResult.data ?? [],
      metaResult.data ?? [],
    )
    if (renamedCount > 0) {
      await refetchAccounts()
      toast.success(
        `Refreshed from Meta — ${renamedCount} account name${renamedCount === 1 ? '' : 's'} updated to match Meta`,
      )
    } else {
      toast.success('Refreshed from Meta')
    }
  }

  const balanceByAccountId = new Map<
    string,
    {
      remaining: string | null
      low: boolean
      metaDue: string | null
      metaDueHigh: boolean
      currency: string
    }
  >()
  for (const m of metaAccounts ?? []) {
    if (!m.linked_account_id) continue
    // Alert thresholds are flat USD-scale numbers (60, 100) with no FX
    // conversion — same gate as every other Meta-money code path in this
    // integration. Non-USD accounts still show their real figures, they
    // just never trip an alert that would be meaningless at their scale.
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

  // Mirrors adAccountUsdRate() (rate.service.ts): the account's own rate
  // wins when set (>0); a zero/unset account rate means "inherit" and falls
  // back to whichever client currently holds it. The list was previously
  // showing the account's raw stored rate only, which looked identical
  // across every client whenever accounts still carried an old bulk-import
  // override — this shows what will actually be billed.
  function effectiveUsdRate(account: NonNullable<typeof accounts>[number]): string | null {
    if (Number(account.usd_rate) > 0) return account.usd_rate
    if (account.current_client && Number(account.current_client.usd_rate) > 0)
      return account.current_client.usd_rate
    return null
  }

  function accountHealth(
    balance: ReturnType<typeof balanceByAccountId.get>,
  ): RailHealth | null {
    if (!balance || balance.currency !== 'USD') return null
    if (balance.metaDueHigh || (balance.remaining != null && Number(balance.remaining) <= 0))
      return 'over-cap'
    if (balance.low) return 'near-cap'
    return 'on-track'
  }

  return (
    <div>
      <PageHeader
        title="Ad Accounts"
        description="Advertising accounts and their current spending limits."
      >
        {canManageMeta && (
          <>
            <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
              <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Download className="size-4" />
              Import from Meta
            </Button>
          </>
        )}
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New account
        </Button>
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Current client</TableHead>
              <TableHead className="text-right">Current balance</TableHead>
              <TableHead className="text-right">Per USD</TableHead>
              <TableHead className="text-right">Current limit</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-right">Meta Due</TableHead>
              <TableHead className="text-right">Threshold</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={11}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (accounts?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={11}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Megaphone className="size-8 opacity-40" />
                    No ad accounts yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {accounts?.map((account) => {
              const balance = balanceByAccountId.get(account.id)
              return (
              <TableRow
                key={account.id}
                className={railClassName(accountHealth(balance))}
              >
                <TableCell className="num text-xs">
                  {account.account_code}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Link
                      to="/admin/ad-accounts/$accountId"
                      params={{ accountId: account.id }}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {account.name}
                    </Link>
                    {balance?.low && (
                      <span
                        title={`Low remaining Meta balance: ${balance.remaining} ${balance.currency}`}
                      >
                        <Bell className="size-3.5 shrink-0 text-danger" />
                      </span>
                    )}
                    {balance?.metaDueHigh && (
                      <span
                        className="flex shrink-0 -space-x-1.5"
                        title={`High balance owed to Meta: ${balance.metaDue} ${balance.currency}`}
                      >
                        <Bell className="size-3.5 text-danger" />
                        <Bell className="size-3.5 text-danger" />
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {account.platform}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {account.current_client
                    ? account.current_client.name
                    : '—'}
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {account.current_client
                    ? formatBdt(account.current_client.current_due)
                    : '—'}
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {(() => {
                    const rate = effectiveUsdRate(account)
                    if (rate == null) return '—'
                    // Italicized when it's not the account's own override —
                    // i.e. it's inherited from whichever client holds it —
                    // so an admin can tell at a glance why two accounts
                    // under different clients show different figures.
                    const inherited = !(Number(account.usd_rate) > 0)
                    return <span className={inherited ? 'italic' : ''}>৳{rate}</span>
                  })()}
                </TableCell>
                <TableCell className="num text-right font-medium">
                  {formatUsd(account.current_limit_usd)}
                </TableCell>
                <TableCell
                  className={`num text-right ${balance?.low ? 'font-medium text-danger' : 'text-muted-foreground'}`}
                >
                  {balance ? formatCurrencyAmount(balance.remaining, balance.currency) : '—'}
                </TableCell>
                <TableCell
                  className={`num text-right ${balance?.metaDueHigh ? 'font-medium text-danger' : 'text-muted-foreground'}`}
                >
                  {balance ? formatCurrencyAmount(balance.metaDue, balance.currency) : '—'}
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {Number(account.threshold_usd) > 0
                    ? formatUsd(account.threshold_usd)
                    : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={account.status} />
                </TableCell>
              </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      <AccountCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <MetaImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}
