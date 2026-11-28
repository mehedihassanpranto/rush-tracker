import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { deleteAgencyRoleFn } from '@/server/users/agency-role.fns'
import type { AgencyRoleWithUsers } from '@/server/users/agency-role.fns'
import { ROLE_PERMISSION_GROUPS } from '@/lib/permissions/agency-roles'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
import { RoleDialog } from './role-dialog'

const TOTAL = ROLE_PERMISSION_GROUPS.reduce((n, g) => n + g.keys.length, 0)

/** Which areas a role reaches, e.g. "Clients (2/2) · Payments (1/3)". */
function areas(permissions: ReadonlyArray<string>): string {
  const has = new Set(permissions)
  const parts = ROLE_PERMISSION_GROUPS.flatMap((g) => {
    const n = g.keys.filter((k) => has.has(k)).length
    return n > 0 ? [`${g.label} (${n}/${g.keys.length})`] : []
  })
  return parts.join(' · ') || 'Nothing yet'
}

/** The agency's roles (000068). Only a Super Admin edits them. */
export function RolesTab({
  roles,
  isLoading,
  canEdit,
}: {
  roles: Array<AgencyRoleWithUsers> | undefined
  isLoading: boolean
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const deleteRole = useServerFn(deleteAgencyRoleFn)
  const [editing, setEditing] = useState<AgencyRoleWithUsers | undefined>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState<AgencyRoleWithUsers | null>(null)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRole({ data: { id } }),
    onSuccess: () => {
      toast.success('Role deleted')
      void queryClient.invalidateQueries({ queryKey: ['agency-roles'] })
      setDeleting(null)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete role')
      setDeleting(null)
    },
  })

  function open(role?: AgencyRoleWithUsers) {
    setEditing(role)
    setDialogOpen(true)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {canEdit
            ? 'Each staff login has one role. Changing a role changes it for everyone who has it.'
            : 'Only a Super Admin can create or change roles.'}
        </p>
        {canEdit && (
          <Button onClick={() => open()}>
            <Plus className="size-4" />
            New role
          </Button>
        )}
      </div>

      <Card className="gap-0 divide-y p-0">
        <div className="flex items-start gap-3 p-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Super Admin</div>
            <p className="text-sm text-muted-foreground">
              Everything, including roles, Finance and clearing data. Built in — can’t be changed.
            </p>
          </div>
        </div>

        {isLoading &&
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="p-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ))}

        {roles?.map((role) => (
          <div key={role.id} className="flex flex-wrap items-start gap-3 p-4 sm:flex-nowrap">
            <div className="min-w-0 flex-1 basis-full sm:basis-auto">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{role.name}</span>
                <span className="text-xs text-muted-foreground">
                  {role.user_count} {role.user_count === 1 ? 'login' : 'logins'} ·{' '}
                  {role.permissions.length} of {TOTAL} permissions
                </span>
              </div>
              {role.description && (
                <p className="text-sm text-muted-foreground">{role.description}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">{areas(role.permissions)}</p>
            </div>
            {canEdit && (
              <div className="flex shrink-0 gap-1">
                <Button variant="outline" size="sm" onClick={() => open(role)}>
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDeleting(role)}
                  aria-label={`Delete ${role.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </Card>

      <RoleDialog open={dialogOpen} onOpenChange={setDialogOpen} role={editing} />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deleting.user_count > 0
                ? `${deleting.user_count} staff ${deleting.user_count === 1 ? 'login has' : 'logins have'} this role. Give them another role first.`
                : 'Nobody has this role. This can’t be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!deleting || deleting.user_count > 0 || deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deleting) deleteMutation.mutate(deleting.id)
              }}
            >
              Delete role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
