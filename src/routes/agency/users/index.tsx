import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { MoreHorizontal, Plus, ShieldCheck, UserCog } from 'lucide-react'
import { toast } from 'sonner'

import {
  listStaffUsersFn,
  setUserStatusFn,
} from '@/server/users/user.fns'
import type { StaffUser } from '@/server/users/user.fns'
import { listAgencyRolesFn } from '@/server/users/agency-role.fns'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { CreateStaffDialog } from '@/components/admin/user/create-staff-dialog'
import { ChangeRoleDialog } from '@/components/admin/user/change-role-dialog'
import { RolesTab } from '@/components/admin/user/roles-tab'
import { roleOptions } from '@/components/admin/user/role-options'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { ResetMfaDialog } from '@/components/security/reset-mfa-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const Route = createFileRoute('/agency/users/')({
  component: UsersPage,
})

function RoleBadge({ user }: { user: StaffUser }) {
  const isSuper = user.role === 'SUPER_ADMIN'
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
      {isSuper ? 'Super Admin' : (user.agency_role_name ?? 'Admin (old defaults)')}
    </Badge>
  )
}

function UsersPage() {
  const { user } = Route.useRouteContext()
  const canManage = hasPermission(user, PERMISSIONS.USERS_MANAGE)
  const queryClient = useQueryClient()
  const isSuperAdmin = user.role === 'SUPER_ADMIN'
  const listStaff = useServerFn(listStaffUsersFn)
  const listRoles = useServerFn(listAgencyRolesFn)
  const setStatus = useServerFn(setUserStatusFn)

  const [tab, setTab] = useState('staff')
  const [createOpen, setCreateOpen] = useState(false)
  const [roleFor, setRoleFor] = useState<StaffUser | null>(null)
  const [mfaResetFor, setMfaResetFor] = useState<{ user_id: string; name: string } | null>(null)

  const { data: staff, isLoading } = useQuery({
    queryKey: ['staff-users'],
    queryFn: () => listStaff(),
  })
  const { data: roles, isLoading: rolesLoading } = useQuery({
    queryKey: ['agency-roles'],
    queryFn: () => listRoles(),
  })
  const options = roleOptions(user, roles ?? [])

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['staff-users'] })
  }

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
        description="Your agency's staff logins and what each role can do."
      >
        {canManage && tab === 'staff' && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New staff login
          </Button>
        )}
      </PageHeader>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="staff">Staff ({staff?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="roles">Roles ({(roles?.length ?? 0) + 1})</TabsTrigger>
        </TabsList>

        <TabsContent value="staff">
      <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={canManage ? 5 : 4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (staff?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 5 : 4}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <UserCog className="size-8 opacity-40" />
                    No staff logins yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {staff?.map((u) => {
              const isSelf = u.user_id === user.id
              // Only a Super Admin changes a Super Admin (the server agrees).
              const locked = isSelf || (u.role === 'SUPER_ADMIN' && !isSuperAdmin)
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
                    <RoleBadge user={u} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={u.status} />
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={locked}
                            aria-label={`Actions for ${u.full_name || u.email}`}
                          >
                            <MoreHorizontal className="size-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onSelect={() => setRoleFor(u)}>
                            Change role…
                          </DropdownMenuItem>

                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() =>
                              setMfaResetFor({ user_id: u.user_id, name: u.full_name || u.email })
                            }
                          >
                            Reset two-factor sign-in…
                          </DropdownMenuItem>

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
        </TabsContent>

        <TabsContent value="roles">
          <RolesTab roles={roles} isLoading={rolesLoading} canEdit={isSuperAdmin} />
        </TabsContent>
      </Tabs>

      <CreateStaffDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        roleOptions={options}
      />
      <ChangeRoleDialog
        user={roleFor}
        options={options}
        onOpenChange={(o) => {
          if (!o) setRoleFor(null)
        }}
      />
      <ResetMfaDialog target={mfaResetFor} onOpenChange={(o) => !o && setMfaResetFor(null)} />
    </div>
  )
}
