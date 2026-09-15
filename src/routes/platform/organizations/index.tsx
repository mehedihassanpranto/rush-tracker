import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { MoreHorizontal, Pencil, Plus, Shield } from 'lucide-react'
import { toast } from 'sonner'

import {
  listOrganizationsFn,
  updateOrganizationSubscriptionStatusFn,
} from '@/server/organizations/organization.fns'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { EditOrganizationDialog } from '@/components/platform/organizations/edit-organization-dialog'
import { CreateOrganizationDialog } from '@/components/platform/organizations/create-organization-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import type { Organization, OrganizationSubscriptionStatus } from '@/types/domain'

/**
 * The platform panel's organizations screen. Access is enforced by the
 * /platform layout guard (routes/platform/route.tsx), so this route carries
 * no guard of its own; the real boundary is requirePlatformAdmin() on every
 * server fn it calls.
 */
export const Route = createFileRoute('/platform/organizations/')({
  component: OrganizationsPage,
})

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const STATUS_FILTERS: Array<{ value: OrganizationSubscriptionStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'cancelled', label: 'Cancelled' },
]

function OrganizationsPage() {
  const queryClient = useQueryClient()
  const listOrganizations = useServerFn(listOrganizationsFn)
  const setStatus = useServerFn(updateOrganizationSubscriptionStatusFn)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<OrganizationSubscriptionStatus | 'ALL'>(
    'ALL',
  )
  const [editing, setEditing] = useState<Organization | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const { data: organizations, isLoading } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => listOrganizations(),
  })

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; subscription_status: OrganizationSubscriptionStatus }) =>
      setStatus({ data: input }),
    onSuccess: (_org, vars) => {
      toast.success(
        vars.subscription_status === 'active'
          ? 'Organization activated'
          : 'Organization suspended',
      )
      void queryClient.invalidateQueries({ queryKey: ['organizations'] })
      void queryClient.invalidateQueries({ queryKey: ['organization'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to update status'),
  })

  const filtered = (organizations ?? []).filter((o) => {
    if (statusFilter !== 'ALL' && o.subscription_status !== statusFilter) return false
    if (
      search.trim() &&
      !o.name.toLowerCase().includes(search.trim().toLowerCase())
    ) {
      return false
    }
    return true
  })

  return (
    <div>
      <PageHeader
        title="Organizations"
        description="Subscribing agencies — activate, suspend, and track renewal notes. Subscriptions are managed manually; there's no payment gateway."
      >
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New agency
        </Button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as OrganizationSubscriptionStatus | 'ALL')}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
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

            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Shield className="size-8 opacity-40" />
                    No organizations found.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {filtered.map((org) => (
              <TableRow key={org.id}>
                <TableCell>
                  <Link
                    to="/platform/organizations/$organizationId"
                    params={{ organizationId: org.id }}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {org.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge status={org.subscription_status.toUpperCase()} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {org.plan ?? '—'}
                </TableCell>
                <TableCell
                  className="max-w-xs truncate text-muted-foreground"
                  title={org.notes ?? undefined}
                >
                  {org.notes ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {fmtDate(org.created_at)}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing(org)}>
                        <Pencil className="size-4" />
                        Edit
                      </DropdownMenuItem>
                      {org.subscription_status === 'active' ? (
                        <DropdownMenuItem
                          onSelect={() =>
                            statusMutation.mutate({
                              id: org.id,
                              subscription_status: 'suspended',
                            })
                          }
                        >
                          Suspend
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onSelect={() =>
                            statusMutation.mutate({
                              id: org.id,
                              subscription_status: 'active',
                            })
                          }
                        >
                          Activate
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <EditOrganizationDialog
        organization={editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />
      <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
