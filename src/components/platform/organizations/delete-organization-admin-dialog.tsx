import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { deleteOrganizationAdminFn } from '@/server/organizations/organization.fns'
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
 * Confirm permanent deletion of an agency admin's login. The server only
 * allows it for an account with no recorded activity — anything else is
 * refused with a message pointing at deactivation, shown here as a toast.
 *
 * `isLastAdmin` drives an extra warning rather than a block: deleting the
 * only admin is legitimate when cleaning up a mistake, and "Add admin" on
 * this same card makes it recoverable.
 */
export function DeleteOrganizationAdminDialog({
  admin,
  organizationId,
  organizationName,
  isLastAdmin,
  open,
  onOpenChange,
}: {
  admin: { user_id: string; full_name: string; email: string } | null
  organizationId: string
  organizationName: string
  isLastAdmin: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const deleteAdmin = useServerFn(deleteOrganizationAdminFn)

  const mutation = useMutation({
    mutationFn: () =>
      deleteAdmin({
        data: { organization_id: organizationId, user_id: admin!.user_id },
      }),
    onSuccess: () => {
      toast.success('Admin login deleted')
      void queryClient.invalidateQueries({ queryKey: ['organization', organizationId] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to delete admin'),
  })

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {admin?.full_name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the login {admin?.email}. It only works if
            the account has no recorded activity — anyone who has approved,
            adjusted or assigned anything must be deactivated instead, so the
            records naming them keep pointing at a real account. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {isLastAdmin && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            This is {organizationName}'s only admin. Deleting it leaves nobody
            able to sign in to that agency until you add another.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete login
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
