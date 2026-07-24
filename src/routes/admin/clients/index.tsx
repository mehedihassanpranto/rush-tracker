import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { MoreHorizontal, Plus, Trash2, Users } from 'lucide-react'

import { listClientsFn } from '@/server/clients/client.fns'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { ClientFormDialog } from '@/components/admin/client/client-form-dialog'
import { DeleteClientDialog } from '@/components/admin/client/delete-client-dialog'
import { Button } from '@/components/ui/button'
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

export const Route = createFileRoute('/admin/clients/')({
  component: ClientsPage,
})

function ClientsPage() {
  const { user } = Route.useRouteContext()
  const canManage = hasPermission(user, PERMISSIONS.CLIENTS_MANAGE)
  const listClients = useServerFn(listClientsFn)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
  } | null>(null)

  const { data: clients, isLoading } = useQuery({
    queryKey: ['clients'],
    queryFn: () => listClients(),
  })

  return (
    <div>
      <PageHeader title="Clients" description="Client organizations you manage.">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New client
        </Button>
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Company</TableHead>
              <TableHead className="text-center">Active accounts</TableHead>
              <TableHead>Status</TableHead>
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

            {!isLoading && (clients?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 6 : 5}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Users className="size-8 opacity-40" />
                    No clients yet. Create your first one.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {clients?.map((client) => (
              <TableRow key={client.id}>
                <TableCell className="font-mono text-xs">
                  {client.client_code}
                </TableCell>
                <TableCell>
                  <Link
                    to="/admin/clients/$clientId"
                    params={{ clientId: client.id }}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {client.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {client.company_name ?? '—'}
                </TableCell>
                <TableCell className="text-center">
                  {client.active_accounts}
                </TableCell>
                <TableCell>
                  <StatusBadge status={client.status} />
                </TableCell>
                {canManage && (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="size-4" />
                          <span className="sr-only">Actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            setDeleteTarget({
                              id: client.id,
                              name: client.name,
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                          Delete client
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <ClientFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <DeleteClientDialog
        client={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null)
        }}
      />
    </div>
  )
}
