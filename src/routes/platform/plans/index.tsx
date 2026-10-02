import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { CreditCard, Pencil, Plus } from 'lucide-react'

import { listPlansFn } from '@/server/platform/subscription.fns'
import type { PlanWithUsage } from '@/server/platform/subscription.fns'
import { formatBdt } from '@/lib/money/money'
import { PageHeader } from '@/components/shared/page-header'
import { PlanDialog } from '@/components/platform/subscription/plan-dialog'
import { Badge } from '@/components/ui/badge'
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

/**
 * Subscription plans. Guarded by the /platform layout; the real boundary is
 * requirePlatformAdmin() on listPlansFn/upsertPlanFn. Plans are never deleted
 * (payments and agencies reference them) — retire one by unticking Available.
 */
export const Route = createFileRoute('/platform/plans/')({
  component: PlansPage,
})

function limit(n: number | null) {
  return n === null ? <span className="text-muted-foreground">Unlimited</span> : n.toLocaleString()
}

function PlansPage() {
  const listPlans = useServerFn(listPlansFn)
  const [editing, setEditing] = useState<PlanWithUsage | null>(null)
  const [open, setOpen] = useState(false)

  const { data: plans, isLoading } = useQuery({
    queryKey: ['subscription-plans'],
    queryFn: () => listPlans(),
  })

  return (
    <div>
      <PageHeader
        title="Plans"
        description="What each agency pays per month and how much it may use. Assign a plan from an agency's profile."
      >
        <Button
          onClick={() => {
            setEditing(null)
            setOpen(true)
          }}
        >
          <Plus className="size-4" />
          New plan
        </Button>
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Plan</TableHead>
              <TableHead className="text-right">Monthly fee</TableHead>
              <TableHead className="text-right">Active clients</TableHead>
              <TableHead className="text-right">Ad accounts</TableHead>
              <TableHead className="text-right">Staff logins</TableHead>
              <TableHead className="text-right">Agencies</TableHead>
              <TableHead className="w-10 pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!isLoading && (plans ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <CreditCard className="size-8 opacity-40" />
                    No plans yet.
                  </div>
                </TableCell>
              </TableRow>
            )}
            {(plans ?? []).map((p) => (
              <TableRow key={p.id}>
                <TableCell className="pl-6 font-medium">
                  {p.name}
                  {!p.is_active && (
                    <Badge variant="outline" className="ml-2">
                      Retired
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="num text-right">{formatBdt(p.monthly_fee_bdt)}</TableCell>
                <TableCell className="num text-right">{limit(p.max_clients)}</TableCell>
                <TableCell className="num text-right">{limit(p.max_ad_accounts)}</TableCell>
                <TableCell className="num text-right">{limit(p.max_staff)}</TableCell>
                <TableCell className="num text-right">{p.agency_count}</TableCell>
                <TableCell className="pr-6">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() => {
                      setEditing(p)
                      setOpen(true)
                    }}
                  >
                    <Pencil className="size-4" />
                    <span className="sr-only">Edit {p.name}</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <PlanDialog open={open} onOpenChange={setOpen} plan={editing} />
    </div>
  )
}
