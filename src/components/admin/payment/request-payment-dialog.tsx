import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createPaymentRequestFn } from '@/server/payment-requests/payment-request.fns'
import { listActiveClientsFn } from '@/server/ad-accounts/assignment.fns'
import { clientFinancialsFn } from '@/server/ledger/ledger.fns'
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

/** Admin requests a payment from a client (spec §46). */
export function RequestPaymentDialog({
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
  const getFinancials = useServerFn(clientFinancialsFn)
  const createRequest = useServerFn(createPaymentRequestFn)

  const [clientId, setClientId] = useState(fixedClientId ?? '')
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [dueDate, setDueDate] = useState('')

  useEffect(() => {
    if (open) {
      setClientId(fixedClientId ?? '')
      setAmount('')
      setMessage('')
      setDueDate('')
    }
  }, [open, fixedClientId])

  const { data: clients } = useQuery({
    queryKey: ['active-clients'],
    queryFn: () => listClients(),
    enabled: open && !fixedClientId,
  })

  const { data: financials } = useQuery({
    queryKey: ['client-financials', clientId],
    queryFn: () => getFinancials({ data: { client_id: clientId } }),
    enabled: open && clientId !== '',
  })

  const amountNum = Number(amount)
  const valid =
    clientId && amount !== '' && Number.isFinite(amountNum) && amountNum > 0

  const mutation = useMutation({
    mutationFn: () =>
      createRequest({
        data: {
          client_id: clientId,
          requested_amount_bdt: amountNum,
          message: message || undefined,
          due_date: dueDate || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Payment request sent')
      void queryClient.invalidateQueries({ queryKey: ['payment-requests'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request payment</DialogTitle>
          <DialogDescription>
            Asks the client to pay. This does not change their due on its own.
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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Amount (BDT)</Label>
              {financials && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setAmount(financials.current_due)}
                >
                  Full due ({formatBdt(financials.current_due)})
                </button>
              )}
            </div>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Due date (optional)</Label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Message (optional)</Label>
            <Textarea
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
