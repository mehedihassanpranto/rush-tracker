import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { revokePoolAccountFn } from '@/server/platform/pool.fns'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

/**
 * Confirm revoking a pool account from an agency.
 *
 * Revoking takes a working account away from a live customer the moment it is
 * clicked — their admins stop seeing it, and any of their clients holding it
 * lose it too. Every other destructive action in this app confirms first
 * (delete client / agency / admin); this one did not, and a stray
 * click during testing silently stripped a real account from xRush twice
 * before that was noticed. One dropdown click is too little friction for it.
 */
export function RevokeGrantDialog({
  grant,
  open,
  onOpenChange,
}: {
  grant: { adAccountId: string; accountLabel: string; agencyName: string } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const revoke = useServerFn(revokePoolAccountFn)

  const mutation = useMutation({
    mutationFn: () => revoke({ data: { ad_account_id: grant!.adAccountId } }),
    onSuccess: () => {
      toast.success(`Revoked from ${grant?.agencyName} — returned to the pool.`)
      void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
      if (grant) {
        void queryClient.invalidateQueries({
          queryKey: ['pool-account', grant.adAccountId],
        })
      }
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to revoke'),
  })

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Revoke {grant?.accountLabel} from {grant?.agencyName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {grant?.agencyName} loses this account immediately — it disappears
            from their ad accounts, and any of their clients currently assigned
            to it lose it too. The account returns to the pool unassigned and
            can be granted again at any time. Nothing is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Revoke access
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
