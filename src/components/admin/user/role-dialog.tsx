import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  createAgencyRoleFn,
  updateAgencyRoleFn,
} from '@/server/users/agency-role.fns'
import type { AgencyRoleWithUsers } from '@/server/users/agency-role.fns'
import {
  IMPLIED_PERMISSIONS,
  ROLE_PERMISSION_GROUPS,
  normalizeRolePermissions,
} from '@/lib/permissions/agency-roles'
import {
  PERMISSION_LABELS,
  SENSITIVE_PERMISSIONS,
} from '@/lib/permissions/permissions'
import type { PermissionKey } from '@/lib/permissions/permissions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const SENSITIVE = new Set<string>(SENSITIVE_PERMISSIONS)

/** Keys that need `key` to be useful — unticking a view drops what needs it. */
function dependents(key: string): Array<string> {
  return Object.entries(IMPLIED_PERMISSIONS)
    .filter(([, implied]) => implied === key)
    .map(([k]) => k)
}

/**
 * Create or edit one of the agency's roles (000068). Ticking an action ticks
 * the view it needs; unticking a view unticks the actions that need it.
 */
export function RoleDialog({
  open,
  onOpenChange,
  role,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Omitted → a new role. */
  role?: AgencyRoleWithUsers
}) {
  const queryClient = useQueryClient()
  const createRole = useServerFn(createAgencyRoleFn)
  const updateRole = useServerFn(updateAgencyRoleFn)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(role?.name ?? '')
    setDescription(role?.description ?? '')
    setSelected(new Set(role?.permissions ?? []))
    setError(null)
  }, [open, role])

  const mutation = useMutation({
    mutationFn: () => {
      const values = {
        name: name.trim(),
        description: description.trim() || undefined,
        permissions: normalizeRolePermissions(selected),
      }
      return role
        ? updateRole({ data: { id: role.id, ...values } })
        : createRole({ data: values })
    },
    onSuccess: (saved) => {
      toast.success(role ? `Role “${saved.name}” updated` : `Role “${saved.name}” created`)
      void queryClient.invalidateQueries({ queryKey: ['agency-roles'] })
      void queryClient.invalidateQueries({ queryKey: ['staff-users'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save role'),
  })

  function toggle(key: PermissionKey, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) {
        next.add(key)
        const implied = IMPLIED_PERMISSIONS[key]
        if (implied) next.add(implied)
      } else {
        next.delete(key)
        for (const d of dependents(key)) next.delete(d)
      }
      return next
    })
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Give the role a name')
    if (selected.size === 0) return setError('Pick at least one permission')
    setError(null)
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{role ? `Edit role — ${role.name}` : 'New role'}</DialogTitle>
          <DialogDescription>
            {role && role.user_count > 0
              ? `Changes apply to the ${role.user_count} staff ${role.user_count === 1 ? 'login' : 'logins'} with this role the next time they load a page.`
              : 'Pick what people with this role can see and do.'}
          </DialogDescription>
        </DialogHeader>

        <form id="role-form" onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              value={name}
              maxLength={60}
              placeholder="Accountant"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="role-description">Description (optional)</Label>
            <Textarea
              id="role-description"
              rows={2}
              maxLength={300}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <Label>Permissions</Label>
              <span className="text-xs text-muted-foreground">
                {selected.size} selected
              </span>
            </div>
            {ROLE_PERMISSION_GROUPS.map((group) => (
              <fieldset key={group.label} className="rounded-md border p-3">
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </legend>
                <ul className="space-y-2">
                  {group.keys.map((key) => (
                    <li key={key} className="flex items-center gap-2.5">
                      <Checkbox
                        id={`perm-${key}`}
                        checked={selected.has(key)}
                        onCheckedChange={(v) => toggle(key, v === true)}
                      />
                      <Label
                        htmlFor={`perm-${key}`}
                        className="flex-1 text-sm font-normal"
                      >
                        {PERMISSION_LABELS[key]}
                      </Label>
                      {SENSITIVE.has(key) && (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
                        >
                          Sensitive
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </fieldset>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="role-form" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {role ? 'Save role' : 'Create role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
