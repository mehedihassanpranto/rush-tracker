import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus, Repeat } from 'lucide-react'

import { getOrganizationSubscriptionFn } from '@/server/platform/subscription.fns'
import { formatBdt } from '@/lib/money/money'
import { BillingBadge } from '@/components/shared/subscription/billing-badge'
import { UsageMeters } from '@/components/shared/subscription/usage-meters'
import { ChangePlanDialog } from '@/components/platform/subscription/change-plan-dialog'
import { RecordPaymentDialog } from '@/components/platform/subscription/record-payment-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

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

/** Platform-side plan, usage, billing and payment history for one agency. */
export function SubscriptionCard({
  organizationId,
  organizationName,
}: {
  organizationId: string
  organizationName: string
}) {
  const getSubscription = useServerFn(getOrganizationSubscriptionFn)
  const [planOpen, setPlanOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['organization-subscription', organizationId],
    queryFn: () => getSubscription({ data: { organization_id: organizationId } }),
  })

  return (
    <Card className="mb-6 p-0">
      <CardHeader className="px-6 pt-6">
        <CardTitle className="text-base">Plan &amp; billing</CardTitle>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!data} onClick={() => setPlanOpen(true)}>
            <Repeat className="size-4" />
            Change plan
          </Button>
          <Button size="sm" disabled={!data} onClick={() => setPayOpen(true)}>
            <Plus className="size-4" />
            Record payment
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading && <Skeleton className="mx-6 mb-6 h-32" />}
        {error && (
          <p className="px-6 pb-6 text-sm text-destructive">
            Couldn't load billing: {error instanceof Error ? error.message : 'unknown error'}
          </p>
        )}
        {data && (
          <>
            <dl className="grid gap-4 px-6 pb-5 sm:grid-cols-4">
              <div>
                <dt className="text-sm text-muted-foreground">Plan</dt>
                <dd className="mt-1 font-medium">{data.plan?.name ?? 'No plan (no limits)'}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Monthly fee</dt>
                <dd className="num mt-1 font-medium">
                  {data.plan ? formatBdt(data.plan.monthly_fee_bdt) : '—'}
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
            <div className="border-t px-6 py-5">
              <UsageMeters plan={data.plan} usage={data.usage} />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Covers</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Method / reference</TableHead>
                  <TableHead className="pr-6">Recorded by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.payments.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                      No payments recorded yet.
                    </TableCell>
                  </TableRow>
                )}
                {data.payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-6 whitespace-nowrap">
                      {fmtDay(p.period_start)} – {fmtDay(p.period_end)}
                    </TableCell>
                    <TableCell className="num font-medium">{formatBdt(p.amount_bdt)}</TableCell>
                    <TableCell className="text-muted-foreground">{p.plan_name ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {[p.method, p.reference].filter(Boolean).join(' · ') || '—'}
                      {p.note && <div className="text-xs">{p.note}</div>}
                    </TableCell>
                    <TableCell className="pr-6 text-muted-foreground">
                      {p.recorded_by_name ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <ChangePlanDialog
              open={planOpen}
              onOpenChange={setPlanOpen}
              organizationId={organizationId}
              organizationName={organizationName}
              currentPlanId={data.plan?.id ?? null}
              billingExempt={data.billing_exempt}
              usage={data.usage}
            />
            <RecordPaymentDialog
              open={payOpen}
              onOpenChange={setPayOpen}
              organizationId={organizationId}
              organizationName={organizationName}
              planName={data.plan?.name ?? null}
              planFeeBdt={data.plan?.monthly_fee_bdt ?? null}
              paidThrough={data.paid_through}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}
