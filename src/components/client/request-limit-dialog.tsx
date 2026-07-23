import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  createLimitRequestFn,
  listMyRequestableAccountsFn,
} from '@/server/limit-requests/limit-request.fns'
import { addUsd, formatUsd } from '@/lib/money/money'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Client limit request (spec §21). Shows opening balance and the expected new
 * limit live; submitting only creates a PENDING request — no due changes.
 */
export function RequestLimitDialog({
  open,
  onOpenChange,
  presetAccountId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presetAccountId?: string
}) {
  const queryClient = useQueryClient()
  const listAccounts = useServerFn(listMyRequestableAccountsFn)
  const createRequest = useServerFn(createLimitRequestFn)

  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')

  const { data: accounts } = useQuery({
    queryKey: ['my-requestable-accounts'],
    queryFn: () => listAccounts(),
    enabled: open,
  })

  useEffect(() => {
    if (open) {
      setAccountId(presetAccountId ?? '')
      setAmount('')
    }
  }, [open, presetAccountId])

  // Accounts eligible to receive a request: active and no pending request.
  const eligible = useMemo(
    () => (accounts ?? []).filter((a) => a.status === 'ACTIVE' && !a.has_pending),
    [accounts],
  )
  const selected = accounts?.find((a) => a.id === accountId)

  const amountNum = Number(amount)
  const amountValid = amount !== '' && Number.isFinite(amountNum) && amountNum > 0
  const expected =
    selected && amountValid
      ? addUsd(selected.current_limit_usd, amountNum).toString()
      : null

  const mutation = useMutation({
    mutationFn: () =>
      createRequest({
        data: { ad_account_id: accountId, requested_amount_usd: amountNum },
      }),
    onSuccess: (req) => {
      toast.success(`Request ${req.request_number} submitted`)
      void queryClient.invalidateQueries({ queryKey: ['my-limit-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['my-requestable-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['client-dashboard-stats'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to submit'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request a limit increase</DialogTitle>
          <DialogDescription>
            Your request is reviewed by the team. Nothing is billed until it is
            approved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Ad account</Label>
            <Select
              value={accountId}
              onValueChange={setAccountId}
              disabled={Boolean(presetAccountId)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.account_code} — {a.name}
                  </SelectItem>
                ))}
                {eligible.length === 0 && (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    No eligible accounts
                  </div>
                )}
              </SelectContent>
            </Select>
            {presetAccountId && selected?.has_pending && (
              <p className="text-xs text-amber-600">
                This account already has a pending request.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Requested amount (USD)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="200"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          {selected && (
            <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/40 p-3 text-sm">
              <div>
                <div className="text-muted-foreground">Opening balance</div>
                <div className="font-medium">
                  {formatUsd(selected.current_limit_usd)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Expected new limit</div>
                <div className="font-medium">
                  {expected ? formatUsd(expected) : '—'}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !accountId ||
              !amountValid ||
              selected?.has_pending ||
              selected?.status !== 'ACTIVE' ||
              mutation.isPending
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
