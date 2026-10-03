import { useMutation } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'

import { resetUserMfaFn } from '@/server/auth/mfa.fns'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/** Remove someone's authenticator(s) — the recovery path for a lost phone.
 * Authorization is server-side (resetUserMfaFn). */
export function ResetMfaDialog({
  target,
  onOpenChange,
}: {
  target: { user_id: string; name: string } | null
  onOpenChange: (open: boolean) => void
}) {
  const reset = useServerFn(resetUserMfaFn)
  const mutation = useMutation({
    mutationFn: () => reset({ data: { user_id: target!.user_id } }),
    onSuccess: (r) => {
      toast.success(
        r.removed > 0
          ? `Two-factor sign-in reset for ${target?.name}.`
          : `${target?.name} had no two-factor sign-in set up.`,
      )
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to reset'),
  })

  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset two-factor sign-in?</AlertDialogTitle>
          <AlertDialogDescription>
            {target?.name}'s authenticator app will be removed. They can then
            sign in with just their password and set two-factor up again. Only
            do this after confirming it's really them — for example when they've
            lost their phone. It is recorded in the audit log.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
          >
            Reset
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
