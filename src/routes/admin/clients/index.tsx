import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus, Users } from 'lucide-react'

import { listClientsFn } from '@/server/clients/client.fns'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { ClientFormDialog } from '@/components/admin/client/client-form-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
  const listClients = useServerFn(listClientsFn)
  const [createOpen, setCreateOpen] = useState(false)

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
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (clients?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <ClientFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
