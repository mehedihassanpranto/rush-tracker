import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { deleteEmployeeFn } from '@/server/employees/employee.fns'
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
 * Confirm hard-deletion of an employee. The server only allows it when the
 * employee has no current client assignments; otherwise it returns an error
 * telling the admin to unassign first (shown here as a toast).
 */
export function DeleteEmployeeDialog({
  employee,
  open,
  onOpenChange,
}: {
  employee: { id: string; name: string } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const deleteEmployee = useServerFn(deleteEmployeeFn)

  const mutation = useMutation({
    mutationFn: () => deleteEmployee({ data: { id: employee!.id } }),
    onSuccess: () => {
      toast.success('Employee deleted')
      void queryClient.invalidateQueries({ queryKey: ['employees'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : 'Failed to delete employee',
      ),
  })

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {employee?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the employee. It only works if they have
            no client assignments — unassign them from every client first
            otherwise. This cannot be undone.
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
            Delete employee
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
