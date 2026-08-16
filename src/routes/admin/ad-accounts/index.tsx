import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Bell, Download, Megaphone, Plus } from 'lucide-react'

import { listAdAccountsFn } from '@/server/ad-accounts/ad-account.fns'
import { listMetaBusinessAdAccountsFn } from '@/server/meta/meta.fns'
import { dec, formatBdt, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
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
  const listAccounts = useServerFn(listAdAccountsFn)
  const listMetaAccounts = useServerFn(listMetaBusinessAdAccountsFn)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['ad-accounts'],
    queryFn: () => listAccounts(),
  })

  // Reuses the same bulk Meta fetch that powers "Import from Meta" (two
  // Graph API calls total, not one per row) — errors (e.g. Meta not
  // configured) just mean no bells show, never break the list.
  const { data: metaAccounts } = useQuery({
    queryKey: ['meta-business-ad-accounts'],
    queryFn: () => listMetaAccounts(),
    staleTime: 2 * 60 * 1000,
    retry: false,
    throwOnError: false,
  })

  const balanceByAccountId = new Map<string, { remaining: string; currency: string; low: boolean }>()
  for (const m of metaAccounts ?? []) {
    if (!m.linked_account_id || m.spend_cap == null) continue
    const remaining = dec(m.spend_cap).minus(dec(m.amount_spent ?? 0))
    balanceByAccountId.set(m.linked_account_id, {
      remaining: remaining.toFixed(2),
      currency: m.currency ?? '',
      low: remaining.lte(LOW_BALANCE_THRESHOLD),
    })
  }

  return (
    <div>
      <PageHeader
        title="Ad Accounts"
        description="Advertising accounts and their current spending limits."
      >
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Download className="size-4" />
          Import from Meta
        </Button>
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
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (accounts?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={9}>
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
              <TableRow key={account.id}>
                <TableCell className="font-mono text-xs">
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
                        <Bell className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
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
                <TableCell className="text-right text-muted-foreground">
                  {account.current_client
                    ? formatBdt(account.current_client.current_due)
                    : '—'}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {Number(account.usd_rate) > 0 ? `৳${account.usd_rate}` : '—'}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatUsd(account.current_limit_usd)}
                </TableCell>
                <TableCell
                  className={`text-right ${balance?.low ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
                >
                  {balance ? formatCurrencyAmount(balance.remaining, balance.currency) : '—'}
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
