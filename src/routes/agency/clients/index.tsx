import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { MoreHorizontal, Plus, Trash2, Users } from 'lucide-react'

import { listClientsFn } from '@/server/clients/client.fns'
import { listAdAccountsFn } from '@/server/ad-accounts/ad-account.fns'
import { listUsableMetaAdAccountsFn } from '@/server/meta/meta.fns'
import { dec, formatBdt, formatUsd } from '@/lib/money/money'
import { hasPermission } from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { railClassName, type RailHealth } from '@/components/shared/status-rail'
import { LOW_BALANCE_THRESHOLD } from '@/lib/meta/thresholds'
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

export const Route = createFileRoute('/agency/clients/')({
  component: ClientsPage,
})

function ClientsPage() {
  const { user } = Route.useRouteContext()
  const canManage = hasPermission(user, PERMISSIONS.CLIENTS_MANAGE)
  const canManageMeta = hasPermission(user, PERMISSIONS.AD_ACCOUNTS_MANAGE)
  const listClients = useServerFn(listClientsFn)
  const listAccounts = useServerFn(listAdAccountsFn)
  const listMetaAccounts = useServerFn(listUsableMetaAdAccountsFn)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
  } | null>(null)

  const { data: clients, isLoading } = useQuery({
    queryKey: ['clients'],
    queryFn: () => listClients(),
  })

  // Bulk ad accounts (each carries its current client) + the same bulk Meta
  // fetch the ad accounts list page uses, joined client-side to get "sum of
  // Meta spend headroom across this client's accounts" — no new server fn,
  // no per-client query.
  const { data: accounts } = useQuery({
    queryKey: ['ad-accounts'],
    queryFn: () => listAccounts(),
  })
  const { data: metaAccounts } = useQuery({
    queryKey: ['meta-usable-ad-accounts'],
    queryFn: () => listMetaAccounts(),
    enabled: canManageMeta,
    staleTime: 2 * 60 * 1000,
    retry: false,
    throwOnError: false,
  })

  const remainingByAccountId = new Map<string, string | null>()
  for (const m of metaAccounts ?? []) {
    if (!m.linked_account_id || m.currency !== 'USD') continue
    remainingByAccountId.set(
      m.linked_account_id,
      m.spend_cap != null
        ? dec(m.spend_cap).minus(dec(m.amount_spent ?? 0)).toFixed(2)
        : null,
    )
  }
  const remainingByClientId = new Map<string, string>()
  if (canManageMeta && metaAccounts !== undefined) {
    for (const account of accounts ?? []) {
      if (!account.current_client) continue
      const remaining = remainingByAccountId.get(account.id)
      if (remaining == null) continue
      const clientId = account.current_client.id
      const prior = remainingByClientId.get(clientId)
      remainingByClientId.set(
        clientId,
        (prior ? dec(prior).plus(remaining) : dec(remaining)).toFixed(2),
      )
    }
  }

  // Client-level equivalent of the ad accounts list's rail: sum of Meta
  // spend headroom across the client's own linked USD accounts (the same
  // figure the "Remaining" column below shows). Unknown when Meta data
  // hasn't resolved yet (no bulk fetch permission, or it's still loading).
  function clientHealth(clientId: string): RailHealth | null {
    if (!canManageMeta || metaAccounts === undefined) return null
    const remaining = remainingByClientId.get(clientId)
    if (remaining == null) return null
    const value = Number(remaining)
    if (value <= 0) return 'over-cap'
    if (value <= LOW_BALANCE_THRESHOLD) return 'near-cap'
    return 'on-track'
  }

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
              <TableHead className="text-right">Current due (BDT)</TableHead>
              <TableHead className="text-right">Current due (USD)</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={canManage ? 9 : 8}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (clients?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 9 : 8}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Users className="size-8 opacity-40" />
                    No clients yet. Create your first one.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {clients?.map((client) => (
              <TableRow
                key={client.id}
                className={railClassName(clientHealth(client.id))}
              >
                <TableCell className="num text-xs">
                  {client.client_code}
                </TableCell>
                <TableCell>
                  <Link
                    to="/agency/clients/$clientId"
                    params={{ clientId: client.id }}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {client.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {client.company_name ?? '—'}
                </TableCell>
                <TableCell className="num text-center">
                  {client.active_accounts}
                </TableCell>
                <TableCell className="num text-right font-medium">
                  {formatBdt(client.current_due)}
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {formatUsd(client.current_due_usd)}
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {remainingByClientId.has(client.id)
                    ? formatUsd(remainingByClientId.get(client.id)!)
                    : '—'}
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
