import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus, SlidersHorizontal } from 'lucide-react'

import { listAdjustmentsFn } from '@/server/adjustments/adjustment.fns'
import { formatBdt } from '@/lib/money/money'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { CreateAdjustmentDialog } from '@/components/admin/adjustment/create-adjustment-dialog'
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

export const Route = createFileRoute('/admin/adjustments/')({
  component: AdjustmentsPage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function AdjustmentsPage() {
  const { user } = Route.useRouteContext()
  const canCreate = hasPermission(user, PERMISSIONS.ADJUSTMENTS_CREATE)
  const listAdjustments = useServerFn(listAdjustmentsFn)
  const [createOpen, setCreateOpen] = useState(false)

  const { data: adjustments, isLoading } = useQuery({
    queryKey: ['adjustments', 'all'],
    queryFn: () => listAdjustments({ data: {} }),
  })

  return (
    <div>
      <PageHeader
        title="Adjustments"
        description="Manual due corrections and reversals."
      >
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New adjustment
          </Button>
        )}
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (adjustments?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <SlidersHorizontal className="size-8 opacity-40" />
                    No adjustments yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {adjustments?.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs">
                  {a.adjustment_number}
                </TableCell>
                <TableCell>
                  {a.client ? (
                    <Link
                      to="/admin/clients/$clientId"
                      params={{ clientId: a.client.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {a.client.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={a.type} />
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatBdt(a.amount_bdt)}
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {a.reason}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(a.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <CreateAdjustmentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
