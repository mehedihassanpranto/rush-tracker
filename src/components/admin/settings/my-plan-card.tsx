import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'

import { getMySubscriptionFn } from '@/server/subscription/subscription.fns'
import { formatBdt } from '@/lib/money/money'
import { BillingBadge } from '@/components/shared/subscription/billing-badge'
import { UsageMeters } from '@/components/shared/subscription/usage-meters'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

function fmtDay(d: string | null): string {
  if (!d) return '—'
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** The agency's own plan and usage — read-only; the platform changes plans. */
export function MyPlanCard() {
  const getMySubscription = useServerFn(getMySubscriptionFn)
  const { data, isLoading } = useQuery({
    queryKey: ['my-subscription'],
    queryFn: () => getMySubscription(),
  })

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Your plan</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="space-y-5">
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-muted-foreground">Plan</dt>
                <dd className="mt-1 font-medium">
                  {data.plan ? `${data.plan.name} — ${formatBdt(data.plan.monthly_fee_bdt)}/month` : 'No plan (no limits)'}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Paid through</dt>
                <dd className="mt-1 font-medium">{fmtDay(data.paid_through)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Billing</dt>
                <dd className="mt-1">
                  <BillingBadge status={data.billing_status} />
                </dd>
              </div>
            </dl>
            <UsageMeters plan={data.plan} usage={data.usage} />
            <p className="text-xs text-muted-foreground">
              To change your plan or report a payment, contact the platform.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
