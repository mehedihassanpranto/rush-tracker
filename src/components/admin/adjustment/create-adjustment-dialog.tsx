import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createAdjustmentFn } from '@/server/adjustments/adjustment.fns'
import { listActiveClientsFn } from '@/server/ad-accounts/assignment.fns'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Create a manual adjustment (spec §40). ADD_DUE increases the client's due,
 * REDUCE_DUE decreases it — each writes exactly one ledger row.
 */
export function CreateAdjustmentDialog({
  open,
  onOpenChange,
  fixedClientId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fixedClientId?: string
}) {
  const queryClient = useQueryClient()
  const listClients = useServerFn(listActiveClientsFn)
  const createAdjustment = useServerFn(createAdjustmentFn)

  const [clientId, setClientId] = useState(fixedClientId ?? '')
  const [type, setType] = useState<'ADD_DUE' | 'REDUCE_DUE'>('ADD_DUE')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (open) {
      setClientId(fixedClientId ?? '')
      setType('ADD_DUE')
      setAmount('')
      setReason('')
      setNote('')
    }
  }, [open, fixedClientId])

  const { data: clients } = useQuery({
    queryKey: ['active-clients'],
    queryFn: () => listClients(),
    enabled: open && !fixedClientId,
  })

  const amountNum = Number(amount)
  const valid =
    clientId &&
    amount !== '' &&
    Number.isFinite(amountNum) &&
    amountNum > 0 &&
    reason.trim().length > 0

  const mutation = useMutation({
    mutationFn: () =>
      createAdjustment({
        data: {
          client_id: clientId,
          type,
          amount_bdt: amountNum,
          reason: reason.trim(),
          internal_note: note.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Adjustment created')
      void queryClient.invalidateQueries({ queryKey: ['adjustments'] })
      void queryClient.invalidateQueries({ queryKey: ['client-financials', clientId] })
      void queryClient.invalidateQueries({ queryKey: ['client-ledger', clientId] })
      void queryClient.invalidateQueries({ queryKey: ['ledger'] })
      void queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create adjustment</DialogTitle>
          <DialogDescription>
            Corrects a client&apos;s due without editing approved records. This
            writes a ledger entry.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!fixedClientId && (
            <div className="space-y-2">
              <Label>Client</Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a client" />
                </SelectTrigger>
                <SelectContent>
                  {clients?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.client_code} — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as 'ADD_DUE' | 'REDUCE_DUE')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADD_DUE">Add due (debit)</SelectItem>
                  <SelectItem value="REDUCE_DUE">Reduce due (credit)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount (BDT)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Reason (visible on statement)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Internal note (optional, admin-only)</Label>
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Create adjustment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
