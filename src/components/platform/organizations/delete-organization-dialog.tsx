import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { deleteOrganizationFn } from '@/server/organizations/organization.fns'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Organization } from '@/types/domain'

/**
 * Permanently offboard an agency. The single most destructive action in the
 * app, so the confirmation is the agency's own NAME rather than a fixed phrase
 * — every agency's screen looks identical, and a fixed phrase is easy to type
 * confidently on the wrong one.
 *
 * The server refuses unless the subscription is already `cancelled`; this
 * dialog says so up front rather than letting the admin discover it on submit.
 */
export function DeleteOrganizationDialog({
  organization,
  counts,
  open,
  onOpenChange,
}: {
  organization: Organization | null
  counts: { clients: number; adAccounts: number; staff: number; portalLogins: number }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const deleteOrganization = useServerFn(deleteOrganizationFn)
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) setName('')
  }, [open])

  const isCancelled = organization?.subscription_status === 'cancelled'
  const matches = name.trim() === organization?.name

  const mutation = useMutation({
    mutationFn: () =>
      deleteOrganization({
        data: { id: organization!.id, confirm_name: name.trim() },
      }),
    onSuccess: (result) => {
      toast.success(
        `${organization?.name} deleted — ${result.deleted_logins} login(s) removed.`,
      )
      void queryClient.invalidateQueries({ queryKey: ['organizations'] })
      onOpenChange(false)
      void navigate({ to: '/platform/organizations' })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to delete agency'),
  })

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {organization?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the agency and everything belonging to it.
            It cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
          <p className="mb-1 font-medium">This will delete</p>
          <ul className="list-inside list-disc text-muted-foreground">
            <li>{counts.clients} client(s) and their entire ledger history</li>
            <li>{counts.adAccounts} ad account(s) they own</li>
            <li>{counts.staff} staff login(s) and {counts.portalLogins} portal login(s)</li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Ad accounts granted from the platform pool are not deleted — they
            return to the pool, unassigned.
          </p>
        </div>

        {!isCancelled && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            Set this agency to <strong>Cancelled</strong> first. Deleting an
            active or suspended subscription is not a one-step action.
          </p>
        )}

        {isCancelled && (
          <div className="space-y-2">
            <Label htmlFor="confirm-agency-name">
              Type <strong>{organization?.name}</strong> to confirm
            </Label>
            <Input
              id="confirm-agency-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!isCancelled || !matches || mutation.isPending}
            onClick={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete agency
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
