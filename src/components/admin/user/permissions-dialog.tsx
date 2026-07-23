import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { setUserPermissionsFn } from '@/server/users/user.fns'
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_LABELS,
  SENSITIVE_PERMISSIONS,
} from '@/lib/permissions/permissions'
import type { PermissionKey } from '@/lib/permissions/permissions'
import type { StaffUser } from '@/server/users/user.fns'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const SENSITIVE = new Set<string>(SENSITIVE_PERMISSIONS)

/**
 * Grant/revoke an ADMIN user's per-user permissions. Role-default permissions
 * are always-on (shown checked + locked); the grantable extras (sensitive
 * permissions and any non-default) toggle the user_permissions rows.
 */
export function PermissionsDialog({
  user,
  adminDefaults,
  open,
  onOpenChange,
}: {
  user: StaffUser | null
  adminDefaults: Array<string>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const setPermissions = useServerFn(setUserPermissionsFn)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const defaults = new Set(adminDefaults)

  useEffect(() => {
    if (open && user) setSelected(new Set(user.granted_permissions))
  }, [open, user])

  const mutation = useMutation({
    mutationFn: () =>
      setPermissions({
        data: {
          user_id: user!.user_id,
          // Persist only the non-default grants (defaults come from the role).
          permissions: [...selected].filter(
            (k) => !defaults.has(k),
          ) as Array<PermissionKey>,
        },
      }),
    onSuccess: () => {
      toast.success('Permissions updated')
      void queryClient.invalidateQueries({ queryKey: ['staff-users'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : 'Failed to update permissions',
      ),
  })

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Permissions — {user?.full_name}</DialogTitle>
          <DialogDescription>
            Role defaults are always granted. Toggle the additional permissions
            this admin should have. Sensitive permissions are highlighted.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1">
          {(ALL_PERMISSION_KEYS as Array<PermissionKey>).map((key) => {
            const isDefault = defaults.has(key)
            const checked = isDefault || selected.has(key)
            return (
              <li key={key}>
                <label
                  className={`flex items-center gap-3 rounded-md border p-2.5 text-sm ${
                    isDefault ? 'opacity-70' : 'cursor-pointer hover:bg-muted/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={checked}
                    disabled={isDefault}
                    onChange={() => toggle(key)}
                  />
                  <span className="flex-1">{PERMISSION_LABELS[key]}</span>
                  {SENSITIVE.has(key) && (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
                    >
                      Sensitive
                    </Badge>
                  )}
                  {isDefault && (
                    <span className="text-xs text-muted-foreground">
                      role default
                    </span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
