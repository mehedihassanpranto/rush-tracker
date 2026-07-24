import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { deleteClientFn } from '@/server/clients/client.fns'
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
 * Confirm hard-deletion of a client. The server only allows it when the client
 * has no financial/account history; otherwise it returns an error telling the
 * admin to deactivate instead (shown here as a toast).
 */
export function DeleteClientDialog({
  client,
  open,
  onOpenChange,
}: {
  client: { id: string; name: string } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const deleteClient = useServerFn(deleteClientFn)

  const mutation = useMutation({
    mutationFn: () => deleteClient({ data: { id: client!.id } }),
    onSuccess: () => {
      toast.success('Client deleted')
      void queryClient.invalidateQueries({ queryKey: ['clients'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : 'Failed to delete client',
      ),
  })

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {client?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the client and any unused logins linked to
            it. It only works if the client has no ledger, payments, requests or
            account assignments — otherwise deactivate it instead to preserve the
            financial record. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete client
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
