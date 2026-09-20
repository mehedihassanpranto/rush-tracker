import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createAccountRequestFn } from '@/server/ad-accounts/account-request.fns'
import { accountRequestCreateSchema } from '@/schemas/account-request'
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

/**
 * "Request Ad Account" (spec §4.4) — the agency asks the platform for a new
 * platform-managed account. One free-text field on purpose: the platform's
 * decision is just "assign one or not", not a multi-field intake.
 */
export function RequestAdAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const createRequest = useServerFn(createAccountRequestFn)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setNotes('')
      setError(null)
    }
  }, [open])

  const mutation = useMutation({
    mutationFn: (value: string) => createRequest({ data: { notes: value } }),
    onSuccess: (row) => {
      toast.success(`Request ${row.request_number} sent to the platform`)
      void queryClient.invalidateQueries({ queryKey: ['my-account-requests'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  function submit() {
    const parsed = accountRequestCreateSchema.safeParse({ notes })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid request')
      return
    }
    setError(null)
    mutation.mutate(parsed.data.notes)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request an ad account</DialogTitle>
          <DialogDescription>
            Ask the platform to assign you another ad account. It goes straight
            to the platform team — there is no review step on your side.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="account-request-notes">What is it for?</Label>
          <Textarea
            id="account-request-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. A new client is starting next week and we have no free account. A starting spend cap of $500 would be enough."
            rows={5}
            maxLength={1000}
            aria-invalid={error ? true : undefined}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
