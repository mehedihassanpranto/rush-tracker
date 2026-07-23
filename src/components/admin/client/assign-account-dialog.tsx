import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { assignAccountFn, listAssignableAccountsFn } from '@/server/ad-accounts/assignment.fns'
import { formatUsd } from '@/lib/money/money'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Assign an AVAILABLE ad account to a fixed client (spec §15). */
export function AssignAccountDialog({
  open,
  onOpenChange,
  clientId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
}) {
  const queryClient = useQueryClient()
  const listAssignable = useServerFn(listAssignableAccountsFn)
  const assign = useServerFn(assignAccountFn)
  const [accountId, setAccountId] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) {
      setAccountId('')
      setNotes('')
    }
  }, [open])

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['assignable-accounts'],
    queryFn: () => listAssignable(),
    enabled: open,
  })

  const mutation = useMutation({
    mutationFn: () =>
      assign({
        data: { ad_account_id: accountId, client_id: clientId, notes: notes || undefined },
      }),
    onSuccess: () => {
      toast.success('Account assigned')
      void queryClient.invalidateQueries({ queryKey: ['client-accounts', clientId] })
      void queryClient.invalidateQueries({ queryKey: ['assignable-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['clients'] })
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to assign'),
  })

  const selected = accounts?.find((a) => a.id === accountId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign ad account</DialogTitle>
          <DialogDescription>
            The account&apos;s current limit becomes this client&apos;s opening
            balance. This creates no due.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Available account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    isLoading ? 'Loading…' : 'Select an available account'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {accounts?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.account_code} — {a.name}
                  </SelectItem>
                ))}
                {!isLoading && (accounts?.length ?? 0) === 0 && (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    No available accounts
                  </div>
                )}
              </SelectContent>
            </Select>
          </div>

          {selected && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              Opening balance:{' '}
              <span className="font-medium">
                {formatUsd(selected.current_limit_usd)}
              </span>
            </div>
          )}

          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!accountId || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
