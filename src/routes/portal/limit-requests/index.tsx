import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { FileText, Gauge, Plus } from 'lucide-react'
import { toast } from 'sonner'

import {
  cancelMyLimitRequestFn,
  getMyProofUrlFn,
  listMyLimitRequestsFn,
} from '@/server/limit-requests/limit-request.fns'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { ProofViewerDialog } from '@/components/shared/proof-viewer'
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
import type { LimitRequestWithRefs } from '@/types/domain'

export const Route = createFileRoute('/portal/limit-requests/')({
  component: MyLimitRequestsPage,
})

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function MyLimitRequestsPage() {
  const queryClient = useQueryClient()
  const listRequests = useServerFn(listMyLimitRequestsFn)
  const getProofUrl = useServerFn(getMyProofUrlFn)
  const cancelRequest = useServerFn(cancelMyLimitRequestFn)
  const [requestOpen, setRequestOpen] = useState(false)
  const [proofId, setProofId] = useState<string | null>(null)

  const { data: requests, isLoading } = useQuery({
    queryKey: ['my-limit-requests'],
    queryFn: () => listRequests(),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelRequest({ data: { id } }),
    onSuccess: () => {
      toast.success('Request cancelled')
      void queryClient.invalidateQueries({ queryKey: ['my-limit-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['my-requestable-accounts'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  function viewProof(id: string) {
    setProofId(id)
  }

  return (
    <div>
      <PageHeader
        title="Limit Requests"
        description="Your limit increase requests and their status."
      >
        <Button onClick={() => setRequestOpen(true)}>
          <Plus className="size-4" />
          New request
        </Button>
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Requested</TableHead>
              <TableHead className="text-right">Approved</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">New limit</TableHead>
              <TableHead className="text-right">Charge</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={11}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (requests?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={11}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Gauge className="size-8 opacity-40" />
                    No limit requests yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {requests?.map((r: LimitRequestWithRefs) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  {r.request_number}
                </TableCell>
                <TableCell>{r.ad_account?.name ?? '—'}</TableCell>
                <TableCell className="text-right">
                  {formatUsd(r.opening_balance_usd)}
                </TableCell>
                <TableCell className="text-right">
                  {formatUsd(r.requested_amount_usd)}
                </TableCell>
                <TableCell className="text-right">
                  {r.approved_amount_usd ? formatUsd(r.approved_amount_usd) : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {r.approved_usd_rate ? `৳${r.approved_usd_rate}` : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {r.approved_new_limit_usd
                    ? formatUsd(r.approved_new_limit_usd)
                    : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {r.bdt_charge ? formatBdt(r.bdt_charge) : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDate(r.created_at)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {r.status === 'APPROVED' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void viewProof(r.id)}
                      >
                        <FileText className="size-4" />
                        Proof
                      </Button>
                    )}
                    {r.status === 'PENDING' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancelMutation.isPending}
                        onClick={() => cancelMutation.mutate(r.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <RequestLimitDialog open={requestOpen} onOpenChange={setRequestOpen} />
      <ProofViewerDialog
        open={proofId !== null}
        onOpenChange={(o) => {
          if (!o) setProofId(null)
        }}
        fetchUrl={() => getProofUrl({ data: { id: proofId! } })}
        title="Approval proof"
      />
    </div>
  )
}
