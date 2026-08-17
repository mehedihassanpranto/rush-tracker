import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { MoreHorizontal, Plus, UserRound } from 'lucide-react'
import { toast } from 'sonner'

import { listEmployeesFn, setEmployeeStatusFn } from '@/server/employees/employee.fns'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { EmployeeFormDialog } from '@/components/admin/employee/employee-form-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import type { Employee, EmployeeWithClients } from '@/types/domain'

export const Route = createFileRoute('/admin/employees/')({
  component: EmployeesPage,
})

function EmployeesPage() {
  const { user } = Route.useRouteContext()
  const canManage = hasPermission(user, PERMISSIONS.EMPLOYEES_MANAGE)
  const queryClient = useQueryClient()
  const listEmployees = useServerFn(listEmployeesFn)
  const setStatus = useServerFn(setEmployeeStatusFn)

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Employee | undefined>()

  const { data: employees, isLoading } = useQuery({
    queryKey: ['employees'],
    queryFn: () => listEmployees(),
  })

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: 'ACTIVE' | 'INACTIVE' }) =>
      setStatus({ data: input }),
    onSuccess: () => {
      toast.success('Status updated')
      void queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  function openEdit(e: EmployeeWithClients) {
    setEditTarget(e)
    setCreateOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="Employees"
        description="Agency staff and which clients they currently service."
      >
        {canManage && (
          <Button
            onClick={() => {
              setEditTarget(undefined)
              setCreateOpen(true)
            }}
          >
            <Plus className="size-4" />
            New employee
          </Button>
        )}
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Clients</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (employees?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <UserRound className="size-8 opacity-40" />
                    No employees yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {employees?.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-mono text-xs">
                  {e.employee_code}
                </TableCell>
                <TableCell className="font-medium">{e.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {e.email ?? '—'}
                </TableCell>
                <TableCell>
                  {e.clients.length === 0 ? (
                    <span className="text-muted-foreground">Unassigned</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {e.clients.map((c) => (
                        <Badge key={c.id} variant="secondary">
                          {c.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={e.status} />
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => openEdit(e)}>
                          Edit
                        </DropdownMenuItem>
                        {e.status === 'ACTIVE' ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              statusMutation.mutate({ id: e.id, status: 'INACTIVE' })
                            }
                          >
                            Deactivate
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onSelect={() =>
                              statusMutation.mutate({ id: e.id, status: 'ACTIVE' })
                            }
                          >
                            Activate
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <EmployeeFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        employee={editTarget}
      />
    </div>
  )
}
