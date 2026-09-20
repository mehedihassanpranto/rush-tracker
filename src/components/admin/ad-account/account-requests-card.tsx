import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'

import {
  cancelAccountRequestFn,
  listMyAccountRequestsFn,
} from '@/server/ad-accounts/account-request.fns'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * This agency's own "Request Ad Account" submissions, so it can track them
 * without a separate screen (spec §4.4 step 4). Renders nothing until there
 * is at least one — an empty card on every visit to the accounts list would
 * be noise for an agency that has never asked.
 */
export function AccountRequestsCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const listRequests = useServerFn(listMyAccountRequestsFn)
  const cancelRequest = useServerFn(cancelAccountRequestFn)

  const { data: requests } = useQuery({
    queryKey: ['my-account-requests'],
    queryFn: () => listRequests(),
  })

  const cancel = useMutation({
    mutationFn: (id: string) => cancelRequest({ data: { id } }),
    onSuccess: () => {
      toast.success('Request withdrawn')
      void queryClient.invalidateQueries({ queryKey: ['my-account-requests'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  if (!requests || requests.length === 0) return null

  // Everything still open first, then the most recent resolved ones.
  const visible = [
    ...requests.filter((r) => r.status === 'PENDING'),
    ...requests.filter((r) => r.status !== 'PENDING').slice(0, 5),
  ]

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Ad account requests</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {visible.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{r.request_number}</span>
                  <StatusBadge status={r.status} />
                  <span className="text-xs text-muted-foreground">
                    {fmtDate(r.created_at)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{r.notes}</p>
                {r.status === 'FULFILLED' && r.fulfilled_ad_account && (
                  <p className="text-sm">
                    Assigned{' '}
                    <Link
                      to="/agency/ad-accounts/$accountId"
                      params={{ accountId: r.fulfilled_ad_account.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {r.fulfilled_ad_account.account_code} —{' '}
                      {r.fulfilled_ad_account.name}
                    </Link>
                  </p>
                )}
                {r.status === 'REJECTED' && r.decision_reason && (
                  <p className="text-sm text-destructive">
                    Declined: {r.decision_reason}
                  </p>
                )}
              </div>
              {r.status === 'PENDING' && canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(r.id)}
                >
                  Withdraw
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
