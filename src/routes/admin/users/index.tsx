import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { MoreHorizontal, Plus, ShieldCheck, UserCog } from 'lucide-react'
import { toast } from 'sonner'

import {
  listStaffUsersFn,
  setUserRoleFn,
  setUserStatusFn,
} from '@/server/users/user.fns'
import type { StaffUser } from '@/server/users/user.fns'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { CreateStaffDialog } from '@/components/admin/user/create-staff-dialog'
import { PermissionsDialog } from '@/components/admin/user/permissions-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const Route = createFileRoute('/admin/users/')({
  component: UsersPage,
})

function RoleBadge({ role }: { role: StaffUser['role'] }) {
  const isSuper = role === 'SUPER_ADMIN'
  return (
    <Badge
      variant="outline"
      className={
        isSuper
          ? 'border-transparent bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300'
          : 'border-transparent bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
      }
    >
      {isSuper ? (
        <ShieldCheck className="size-3" />
      ) : (
        <UserCog className="size-3" />
      )}
      {isSuper ? 'Super Admin' : 'Admin'}
    </Badge>
  )
}

function UsersPage() {
  const { user } = Route.useRouteContext()
  const canManage = hasPermission(user, PERMISSIONS.USERS_MANAGE)
  const queryClient = useQueryClient()
  const listStaff = useServerFn(listStaffUsersFn)
  const setRole = useServerFn(setUserRoleFn)
  const setStatus = useServerFn(setUserStatusFn)

  const [createOpen, setCreateOpen] = useState(false)
  const [permsFor, setPermsFor] = useState<StaffUser | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['staff-users'],
    queryFn: () => listStaff(),
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['staff-users'] })
  }

  const roleMutation = useMutation({
    mutationFn: (vars: { user_id: string; role: 'ADMIN' | 'SUPER_ADMIN' }) =>
      setRole({ data: vars }),
    onSuccess: () => {
      toast.success('Role updated')
      invalidate()
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to update role'),
  })

  const statusMutation = useMutation({
    mutationFn: (vars: { user_id: string; status: StaffUser['status'] }) =>
      setStatus({ data: vars }),
    onSuccess: () => {
      toast.success('Status updated')
      invalidate()
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : 'Failed to update status',
      ),
  })

  return (
    <div>
      <PageHeader
        title="Users"
        description="Admin staff, roles and permissions (spec §7, §8)."
      >
        {canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New admin
          </Button>
        )}
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Extra permissions</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={canManage ? 6 : 5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (data?.users.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 6 : 5}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <UserCog className="size-8 opacity-40" />
                    No admin users yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {data?.users.map((u) => {
              const isSelf = u.user_id === user.id
              return (
                <TableRow key={u.user_id}>
                  <TableCell className="font-medium">
                    {u.full_name || '—'}
                    {isSelf && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (you)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.email}
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={u.role} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={u.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.role === 'SUPER_ADMIN'
                      ? 'All (full access)'
                      : u.granted_permissions.length > 0
                        ? `${u.granted_permissions.length} granted`
                        : 'Role defaults only'}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" disabled={isSelf}>
                            <MoreHorizontal className="size-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuLabel>Role</DropdownMenuLabel>
                          <DropdownMenuItem
                            disabled={u.role === 'ADMIN'}
                            onSelect={() =>
                              roleMutation.mutate({
                                user_id: u.user_id,
                                role: 'ADMIN',
                              })
                            }
                          >
                            Make Admin
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={u.role === 'SUPER_ADMIN'}
                            onSelect={() =>
                              roleMutation.mutate({
                                user_id: u.user_id,
                                role: 'SUPER_ADMIN',
                              })
                            }
                          >
                            Make Super Admin
                          </DropdownMenuItem>

                          {u.role === 'ADMIN' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => setPermsFor(u)}
                              >
                                Manage permissions…
                              </DropdownMenuItem>
                            </>
                          )}

                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>Status</DropdownMenuLabel>
                          {(['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const).map(
                            (s) => (
                              <DropdownMenuItem
                                key={s}
                                disabled={u.status === s}
                                onSelect={() =>
                                  statusMutation.mutate({
                                    user_id: u.user_id,
                                    status: s,
                                  })
                                }
                              >
                                Set {s.charAt(0) + s.slice(1).toLowerCase()}
                              </DropdownMenuItem>
                            ),
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      <CreateStaffDialog open={createOpen} onOpenChange={setCreateOpen} />
      <PermissionsDialog
        user={permsFor}
        adminDefaults={data?.adminDefaultPermissions ?? []}
        open={permsFor !== null}
        onOpenChange={(o) => {
          if (!o) setPermsFor(null)
        }}
      />
    </div>
  )
}
