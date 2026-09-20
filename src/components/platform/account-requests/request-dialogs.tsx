import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { listPoolAccountsFn } from '@/server/platform/pool.fns'
import {
  fulfillAccountRequestFn,
  rejectAccountRequestFn,
} from '@/server/platform/account-requests.fns'
import type { PlatformAccountRequestRow } from '@/server/platform/account-requests.fns'
import { accountRequestRejectSchema } from '@/schemas/account-request'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

function invalidateAll(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['platform-account-requests'] })
  void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
}

/** Pick an unassigned pool account and hand it to the requesting agency —
 * the same act as the pool panel's manual Grant, plus closing the request. */
export function AssignRequestDialog({
  request,
  onOpenChange,
}: {
  request: PlatformAccountRequestRow | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const listPool = useServerFn(listPoolAccountsFn)
  const fulfill = useServerFn(fulfillAccountRequestFn)
  const [accountId, setAccountId] = useState('')
  const open = request !== null

  useEffect(() => {
    if (open) setAccountId('')
  }, [open, request?.id])

  const { data: pool, isLoading } = useQuery({
    queryKey: ['platform-pool-accounts'],
    queryFn: () => listPool(),
    enabled: open,
  })

  // Unassigned and not deactivated — the two things that make a pool account
  // genuinely available. fulfillAccountRequestFn re-checks both server-side.
  const available = useMemo(
    () =>
      (pool ?? []).filter(
        (row) => row.granted_to === null && row.account.status !== 'INACTIVE',
      ),
    [pool],
  )

  const mutation = useMutation({
    mutationFn: () =>
      fulfill({ data: { id: request!.id, ad_account_id: accountId } }),
    onSuccess: () => {
      toast.success(`Account assigned to ${request?.organization?.name ?? 'the agency'}`)
      invalidateAll(queryClient)
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign an ad account</DialogTitle>
          <DialogDescription>
            {request?.request_number} — {request?.organization?.name}
          </DialogDescription>
        </DialogHeader>
        {request && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            {request.notes}
          </div>
        )}
        <div className="space-y-2">
          <Label>Pool account</Label>
          {isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No unassigned accounts in the pool. Add one from Meta on the Ad
              Account Pool page, or revoke one that is no longer needed — this
              request stays pending until then.
            </p>
          ) : (
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {available.map(({ account }) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.account_code} — {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!accountId || mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Assign account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Decline with a reason the agency will see. */
export function RejectRequestDialog({
  request,
  onOpenChange,
}: {
  request: PlatformAccountRequestRow | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const reject = useServerFn(rejectAccountRequestFn)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const open = request !== null

  useEffect(() => {
    if (open) {
      setReason('')
      setError(null)
    }
  }, [open, request?.id])

  const mutation = useMutation({
    mutationFn: (value: string) =>
      reject({ data: { id: request!.id, reason: value } }),
    onSuccess: () => {
      toast.success('Request declined')
      invalidateAll(queryClient)
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  function submit() {
    const parsed = accountRequestRejectSchema.safeParse({
      id: request?.id,
      reason,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid reason')
      return
    }
    setError(null)
    mutation.mutate(parsed.data.reason)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decline request</DialogTitle>
          <DialogDescription>
            {request?.request_number} — {request?.organization?.name}. The
            agency sees this reason on its Ad Accounts page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reject-account-request-reason">Reason</Label>
          <Textarea
            id="reject-account-request-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            maxLength={500}
            aria-invalid={error ? true : undefined}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Decline request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
