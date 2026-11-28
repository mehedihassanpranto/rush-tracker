import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { setUserRoleFn } from '@/server/users/user.fns'
import type { StaffUser } from '@/server/users/user.fns'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { RoleOption } from './role-options'

/** Give a staff login a different role. */
export function ChangeRoleDialog({
  user,
  options,
  onOpenChange,
}: {
  user: StaffUser | null
  options: Array<RoleOption>
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const setRole = useServerFn(setUserRoleFn)
  const [value, setValue] = useState('')

  useEffect(() => {
    if (user) setValue(user.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : (user.agency_role_id ?? ''))
  }, [user])

  const mutation = useMutation({
    mutationFn: () => setRole({ data: { user_id: user!.user_id, role: value } }),
    onSuccess: () => {
      toast.success('Role updated')
      void queryClient.invalidateQueries({ queryKey: ['staff-users'] })
      void queryClient.invalidateQueries({ queryKey: ['agency-roles'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update role'),
  })

  const current = user?.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : (user?.agency_role_id ?? '')

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change role — {user?.full_name || user?.email}</DialogTitle>
          <DialogDescription>
            Takes effect the next time they load a page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="change-role">Role</Label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger id="change-role" className="w-full">
              <SelectValue placeholder="Pick a role" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabledReason !== null}>
                  {o.label}
                  {o.disabledReason && (
                    <span className="text-xs text-muted-foreground"> · {o.disabledReason}</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!value || value === current || mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
