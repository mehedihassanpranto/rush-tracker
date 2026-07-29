import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Megaphone, Plus } from 'lucide-react'

import { listAdAccountsFn } from '@/server/ad-accounts/ad-account.fns'
import { formatUsd } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { AccountCreateDialog } from '@/components/admin/ad-account/account-dialogs'
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
  const [createOpen, setCreateOpen] = useState(false)

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['ad-accounts'],
    queryFn: () => listAccounts(),
  })

  return (
    <div>
      <PageHeader
        title="Ad Accounts"
        description="Advertising accounts and their current spending limits."
      >
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
              <TableHead className="text-right">Per USD</TableHead>
              <TableHead className="text-right">Current limit</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (accounts?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Megaphone className="size-8 opacity-40" />
                    No ad accounts yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {accounts?.map((account) => (
              <TableRow key={account.id}>
                <TableCell className="font-mono text-xs">
                  {account.account_code}
                </TableCell>
                <TableCell>
                  <Link
                    to="/admin/ad-accounts/$accountId"
                    params={{ accountId: account.id }}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {account.name}
                  </Link>
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
                    ? `৳${account.current_client.usd_rate}`
                    : '—'}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatUsd(account.current_limit_usd)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={account.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <AccountCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
