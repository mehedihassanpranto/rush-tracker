import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ArrowLeft, Plus } from 'lucide-react'

import {
  getMyAdAccountFn,
  listMyLimitRequestsFn,
} from '@/server/limit-requests/limit-request.fns'
import { listMyAccountsMetaRemainingFn } from '@/server/meta/meta.fns'
import { dec, formatCurrencyAmount, formatUsd } from '@/lib/money/money'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { StatusBadge } from '@/components/shared/status-badge'
import { MyLimitRequestsTable } from '@/components/client/my-limit-requests-table'
import { RequestLimitDialog } from '@/components/client/request-limit-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export const Route = createFileRoute('/client/ad-accounts/$accountId')({
  component: MyAdAccountPage,
})

const SEGMENT_LABELS = {
  prepaid: 'Prepaid — you pay the full cost up front',
  partial: 'Partial — you pay part now, the rest becomes due',
  postpaid: 'Postpaid — the full cost is added to your due',
} as const

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

function MyAdAccountPage() {
  const { accountId } = Route.useParams()
  const getAccount = useServerFn(getMyAdAccountFn)
  const listRequests = useServerFn(listMyLimitRequestsFn)
  const listRemaining = useServerFn(listMyAccountsMetaRemainingFn)
  const [requestOpen, setRequestOpen] = useState(false)

  const { data: account, isLoading, isError } = useQuery({
    queryKey: ['my-ad-account', accountId],
    queryFn: () => getAccount({ data: { ad_account_id: accountId } }),
    retry: false,
  })
  const { data: requests, isLoading: requestsLoading } = useQuery({
    queryKey: ['my-limit-requests', accountId],
    queryFn: () => listRequests({ data: { ad_account_id: accountId } }),
    enabled: Boolean(account),
  })
  // Best-effort, like the accounts list: Meta unreachable just shows '—'.
  const { data: remaining, isLoading: remainingLoading } = useQuery({
    queryKey: ['my-accounts-meta-remaining'],
    queryFn: () => listRemaining(),
    enabled: Boolean(account),
    retry: false,
    throwOnError: false,
  })
  const r = remaining?.find((x) => x.ad_account_id === accountId)
  const low =
    r?.currency === 'USD' && r.remaining != null && dec(r.remaining).lte(LOW_BALANCE_THRESHOLD)

  const back = (
    <Link
      to="/client/ad-accounts"
      className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      My Ad Accounts
    </Link>
  )

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (isError || !account) {
    return (
      <div>
        {back}
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            This ad account isn’t assigned to you.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div>
      {back}

      <PageHeader title={account.name}>
        <Button
          disabled={account.status !== 'ACTIVE' || account.has_pending}
          onClick={() => setRequestOpen(true)}
        >
          <Plus className="size-4" />
          {account.has_pending ? 'Request pending' : 'Request limit'}
        </Button>
      </PageHeader>

      <div className="mb-4 flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{account.account_code}</span>
        <StatusBadge status={account.status} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="limit-requests">
            Limit Requests ({requests?.length ?? 0})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-4 pt-2">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Current limit" value={formatUsd(account.current_limit_usd)} />
            <StatCard
              label="Remaining"
              hint="Limit left to spend, from Meta"
              loading={remainingLoading}
              value={r ? formatCurrencyAmount(r.remaining, r.currency) : '—'}
              valueClassName={low ? 'text-red-600 dark:text-red-400' : undefined}
            />
            <StatCard
              label="Approved for you"
              hint={`${account.approved_count} approved ${account.approved_count === 1 ? 'request' : 'requests'}`}
              value={formatUsd(account.approved_usd)}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <InfoRow label="Code" value={<span className="font-mono text-xs">{account.account_code}</span>} />
                <InfoRow label="Name" value={account.name} />
                <InfoRow label="Status" value={<StatusBadge status={account.status} />} />
                <InfoRow label="Assigned to you" value={fmtDate(account.assigned_at)} />
                <InfoRow label="Limit when assigned" value={<span className="num">{formatUsd(account.opening_limit_usd)}</span>} />
                <InfoRow
                  label="Rate"
                  value={dec(account.usd_rate).gt(0) ? <span className="num">৳{account.usd_rate} per USD</span> : 'Not set'}
                />
                <InfoRow label="Payment terms" value={SEGMENT_LABELS[account.segment]} />
              </dl>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="limit-requests" className="pt-2">
          <Card className="p-0">
            <MyLimitRequestsTable requests={requests} isLoading={requestsLoading} showAccount={false} />
          </Card>
        </TabsContent>
      </Tabs>

      <RequestLimitDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        presetAccountId={account.id}
      />
    </div>
  )
}
