import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  assignAccountFn,
  listActiveClientsFn,
  releaseAccountFn,
} from '@/server/ad-accounts/assignment.fns'
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
import type { AdAccount } from '@/types/domain'

function invalidateAccount(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string,
) {
  void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
  void queryClient.invalidateQueries({ queryKey: ['ad-account', accountId] })
  void queryClient.invalidateQueries({ queryKey: ['assignment-history', accountId] })
  void queryClient.invalidateQueries({ queryKey: ['clients'] })
}

/** Assign this (available) account to a chosen client — spec §15. */
export function AssignToClientDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AdAccount
}) {
  const queryClient = useQueryClient()
  const listClients = useServerFn(listActiveClientsFn)
  const assign = useServerFn(assignAccountFn)
  const [clientId, setClientId] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) {
      setClientId('')
      setNotes('')
    }
  }, [open])

  const { data: clients } = useQuery({
    queryKey: ['active-clients'],
    queryFn: () => listClients(),
    enabled: open,
  })

  const mutation = useMutation({
    mutationFn: () =>
      assign({
        data: {
          ad_account_id: account.id,
          client_id: clientId,
          notes: notes || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Account assigned')
      invalidateAccount(queryClient, account.id)
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign account</DialogTitle>
          <DialogDescription>
            Opening balance {formatUsd(account.current_limit_usd)} carries over
            and creates no due.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
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
            disabled={!clientId || mutation.isPending}
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

/** Release the active assignment — account returns to Available (spec §17). */
export function ReleaseDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AdAccount
}) {
  const queryClient = useQueryClient()
  const release = useServerFn(releaseAccountFn)
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) setNotes('')
  }, [open])

  const mutation = useMutation({
    mutationFn: () =>
      release({ data: { ad_account_id: account.id, notes: notes || undefined } }),
    onSuccess: () => {
      toast.success('Account released')
      invalidateAccount(queryClient, account.id)
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release account</DialogTitle>
          <DialogDescription>
            Closes the current assignment (closing limit{' '}
            {formatUsd(account.current_limit_usd)}) and marks the account
            Available. History is preserved.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Notes (optional)</Label>
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Release
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
