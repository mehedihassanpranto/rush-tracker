import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import {
  RESET_CONFIRM_PHRASE,
  resetAllDataFn,
} from '@/server/admin/maintenance.fns'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ResetDataDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const resetAll = useServerFn(resetAllDataFn)
  const [phrase, setPhrase] = useState('')

  useEffect(() => {
    if (open) setPhrase('')
  }, [open])

  const mutation = useMutation({
    mutationFn: () => resetAll({ data: { confirm: phrase } }),
    onSuccess: async () => {
      toast.success('All data cleared. Set a USD rate to begin again.')
      queryClient.clear()
      onOpenChange(false)
      await router.invalidate()
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to clear data'),
  })

  const confirmed = phrase === RESET_CONFIRM_PHRASE

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlert className="size-5" />
            Clear all data
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>
                This permanently deletes <strong>every</strong> client, ad
                account, limit request, ledger entry, payment, adjustment,
                notification, audit log and proof file — and removes all client
                logins. Your admin logins, roles and permissions are kept.
              </p>
              <p className="font-medium text-destructive">
                This cannot be undone.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="reset-confirm">
            Type <span className="font-mono">{RESET_CONFIRM_PHRASE}</span> to
            confirm
          </Label>
          <Input
            id="reset-confirm"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            autoComplete="off"
            placeholder={RESET_CONFIRM_PHRASE}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={!confirmed || mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Clear all data
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
