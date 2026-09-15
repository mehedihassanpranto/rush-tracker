import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Bell, Megaphone } from 'lucide-react'

import { listMyRequestableAccountsFn } from '@/server/limit-requests/limit-request.fns'
import { listMyAccountsMetaRemainingFn } from '@/server/meta/meta.fns'
import { dec, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
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

export const Route = createFileRoute('/client/ad-accounts/')({
  component: MyAdAccountsPage,
})

function MyAdAccountsPage() {
  const listAccounts = useServerFn(listMyRequestableAccountsFn)
  const listRemaining = useServerFn(listMyAccountsMetaRemainingFn)
  const [requestOpen, setRequestOpen] = useState(false)
  const [presetAccount, setPresetAccount] = useState<string | undefined>()

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['my-requestable-accounts'],
    queryFn: () => listAccounts(),
    select: (result) => result.accounts,
  })

  // Best-effort — if Meta isn't configured or reachable this just shows
  // '—' per row, never breaks the page.
  const { data: remaining } = useQuery({
    queryKey: ['my-accounts-meta-remaining'],
    queryFn: () => listRemaining(),
    retry: false,
    throwOnError: false,
  })
  const remainingByAccountId = new Map(
    (remaining ?? []).map((r) => [r.ad_account_id, r]),
  )

  // Flat USD-scale threshold, no FX conversion — same gate as the admin
  // side's identical alert (src/lib/meta/thresholds.ts).
  function isLowRemaining(r: { remaining: string | null; currency: string | null }) {
    return (
      r.currency === 'USD' &&
      r.remaining != null &&
      dec(r.remaining).lte(LOW_BALANCE_THRESHOLD)
    )
  }

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
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (accounts?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Megaphone className="size-8 opacity-40" />
                    No ad accounts assigned yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {accounts?.map((account) => {
              const r = remainingByAccountId.get(account.id)
              const low = r ? isLowRemaining(r) : false
              return (
              <TableRow key={account.id}>
                <TableCell className="font-mono text-xs">
                  {account.account_code}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{account.name}</span>
                    {low && (
                      <span
                        title={`Low remaining balance: ${formatCurrencyAmount(r!.remaining, r!.currency)}`}
                      >
                        <Bell className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatUsd(account.current_limit_usd)}
                </TableCell>
                <TableCell
                  className={`text-right ${low ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
                >
                  {r ? formatCurrencyAmount(r.remaining, r.currency) : '—'}
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
              )
            })}
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
