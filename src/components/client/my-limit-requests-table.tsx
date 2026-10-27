import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { FileText, Gauge } from 'lucide-react'
import { toast } from 'sonner'

import {
  cancelMyLimitRequestFn,
  getMyProofUrlFn,
} from '@/server/limit-requests/limit-request.fns'
import { formatBdt, formatUsd } from '@/lib/money/money'
import { ProofViewerDialog } from '@/components/shared/proof-viewer'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
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

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** The client's own limit requests, with Proof and Cancel — the Limit
 * Requests page (every account) and one ad account's page (`showAccount`
 * off). */
export function MyLimitRequestsTable({
  requests,
  isLoading,
  showAccount = true,
}: {
  requests: Array<LimitRequestWithRefs> | undefined
  isLoading: boolean
  showAccount?: boolean
}) {
  const queryClient = useQueryClient()
  const getProofUrl = useServerFn(getMyProofUrlFn)
  const cancelRequest = useServerFn(cancelMyLimitRequestFn)
  const [proofId, setProofId] = useState<string | null>(null)
  const columns = showAccount ? 13 : 12

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelRequest({ data: { id } }),
    onSuccess: () => {
      toast.success('Request cancelled')
      void queryClient.invalidateQueries({ queryKey: ['my-limit-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['my-requestable-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['my-ad-account'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Request</TableHead>
            {showAccount && <TableHead>Account</TableHead>}
            <TableHead className="text-right">Opening</TableHead>
            <TableHead className="text-right">Requested</TableHead>
            <TableHead className="text-right">Approved</TableHead>
            <TableHead className="text-right">Rate</TableHead>
            <TableHead className="text-right">New limit</TableHead>
            <TableHead className="text-right">Charge</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">Due</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading &&
            Array.from({ length: 3 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell colSpan={columns}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ))}

          {!isLoading && (requests?.length ?? 0) === 0 && (
            <TableRow>
              <TableCell colSpan={columns}>
                <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                  <Gauge className="size-8 opacity-40" />
                  No limit requests yet.
                </div>
              </TableCell>
            </TableRow>
          )}

          {requests?.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-xs">
                {r.request_number}
              </TableCell>
              {showAccount && <TableCell>{r.ad_account?.name ?? '—'}</TableCell>}
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
              <TableCell className="text-right">
                {r.segment !== 'postpaid' ? formatBdt(r.amount_paid_bdt) : '—'}
              </TableCell>
              <TableCell className="text-right">
                {Number(r.due_balance_bdt) <= 0 ? (
                  <span className="text-emerald-600">Fully paid</span>
                ) : (
                  formatBdt(r.due_balance_bdt)
                )}
              </TableCell>
              <TableCell>
                <StatusBadge status={r.status} />
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {fmtDate(r.created_at)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  {r.segment !== 'postpaid' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setProofId(r.id)}
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

      <ProofViewerDialog
        open={proofId !== null}
        onOpenChange={(o) => {
          if (!o) setProofId(null)
        }}
        fetchUrl={() => getProofUrl({ data: { id: proofId! } })}
        title="Approval proof"
      />
    </>
  )
}
