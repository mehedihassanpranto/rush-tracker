import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { reverseLedgerEntryFn } from '@/server/adjustments/adjustment.fns'
import { formatBdt } from '@/lib/money/money'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { LedgerEntryWithBalance } from '@/types/domain'

/** Reverse a ledger entry (spec §41). The original is preserved; an opposite
 *  entry is added. Requires a reason. */
export function ReverseDialog({
  open,
  onOpenChange,
  entry,
  clientId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry: LedgerEntryWithBalance | null
  clientId: string
}) {
  const queryClient = useQueryClient()
  const reverse = useServerFn(reverseLedgerEntryFn)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (open) setReason('')
  }, [open])

  const amount = entry
    ? Number(entry.debit_bdt) > 0
      ? entry.debit_bdt
      : entry.credit_bdt
    : '0'
  const effect = entry
    ? Number(entry.debit_bdt) > 0
      ? 'reduce the due'
      : 'increase the due'
    : ''

  const mutation = useMutation({
    mutationFn: () => {
      if (!entry) throw new Error('No entry')
      return reverse({ data: { ledger_id: entry.id, reason: reason.trim() } })
    },
    onSuccess: () => {
      toast.success('Transaction reversed')
      void queryClient.invalidateQueries({ queryKey: ['client-financials', clientId] })
      void queryClient.invalidateQueries({ queryKey: ['client-ledger', clientId] })
      void queryClient.invalidateQueries({ queryKey: ['ledger'] })
      void queryClient.invalidateQueries({ queryKey: ['adjustments'] })
      void queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse transaction</DialogTitle>
          <DialogDescription>
            {entry ? (
              <>
                Reverses {entry.transaction_number} ({formatBdt(amount)}). This
                will {effect}. The original entry is kept for the record.
              </>
            ) : (
              'Reverses this transaction.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Reason</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!reason.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Reverse
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
