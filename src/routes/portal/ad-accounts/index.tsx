import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Megaphone } from 'lucide-react'

import { listMyRequestableAccountsFn } from '@/server/limit-requests/limit-request.fns'
import { formatUsd } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { RequestLimitDialog } from '@/components/client/request-limit-dialog'
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

export const Route = createFileRoute('/portal/ad-accounts/')({
  component: MyAdAccountsPage,
})

function MyAdAccountsPage() {
  const listAccounts = useServerFn(listMyRequestableAccountsFn)
  const [requestOpen, setRequestOpen] = useState(false)
  const [presetAccount, setPresetAccount] = useState<string | undefined>()

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['my-requestable-accounts'],
    queryFn: () => listAccounts(),
  })

  function openRequest(accountId: string) {
    setPresetAccount(accountId)
    setRequestOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="My Ad Accounts"
        description="Accounts assigned to you. Request a limit increase on active accounts."
      />

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Current limit</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (accounts?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Megaphone className="size-8 opacity-40" />
                    No ad accounts assigned yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {accounts?.map((account) => (
              <TableRow key={account.id}>
                <TableCell className="font-mono text-xs">
                  {account.account_code}
                </TableCell>
                <TableCell className="font-medium">{account.name}</TableCell>
                <TableCell className="text-right font-medium">
                  {formatUsd(account.current_limit_usd)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={account.status} />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={account.status !== 'ACTIVE' || account.has_pending}
                    onClick={() => openRequest(account.id)}
                  >
                    {account.has_pending ? 'Pending' : 'Request limit'}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <RequestLimitDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        presetAccountId={presetAccount}
      />
    </div>
  )
}
