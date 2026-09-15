import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import {
  ArrowLeft,
  MoreHorizontal,
  Pencil,
  Eye,
  Plus,
  Trash2,
  UserRound,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  getOrganizationFn,
  setOrganizationAdminStatusFn,
  updateOrganizationSubscriptionStatusFn,
} from '@/server/organizations/organization.fns'
import type { OrganizationProfile } from '@/server/organizations/organization.fns'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { StatusBadge } from '@/components/shared/status-badge'
import { EditOrganizationDialog } from '@/components/platform/organizations/edit-organization-dialog'
import { AddOrganizationAdminDialog } from '@/components/platform/organizations/add-organization-admin-dialog'
import { DeleteOrganizationAdminDialog } from '@/components/platform/organizations/delete-organization-admin-dialog'
import { DeleteOrganizationDialog } from '@/components/platform/organizations/delete-organization-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { OrganizationSubscriptionStatus } from '@/types/domain'

export const Route = createFileRoute('/platform/organizations/$organizationId/')({
  component: OrganizationProfilePage,
})

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="max-w-[60%] text-right text-sm">{value}</dd>
    </div>
  )
}

function OrganizationProfilePage() {
  const { organizationId } = Route.useParams()
  const queryClient = useQueryClient()
  const { user } = Route.useRouteContext()
  const getOrganization = useServerFn(getOrganizationFn)
  const setStatus = useServerFn(updateOrganizationSubscriptionStatusFn)
  const setAdminStatus = useServerFn(setOrganizationAdminStatusFn)
  const [editOpen, setEditOpen] = useState(false)
  const [addAdminOpen, setAddAdminOpen] = useState(false)
  const [deleteOrgOpen, setDeleteOrgOpen] = useState(false)
  const [adminToDelete, setAdminToDelete] =
    useState<OrganizationProfile['admins'][number] | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['organization', organizationId],
    queryFn: () => getOrganization({ data: { id: organizationId } }),
  })

  const statusMutation = useMutation({
    mutationFn: (subscription_status: OrganizationSubscriptionStatus) =>
      setStatus({ data: { id: organizationId, subscription_status } }),
    onSuccess: (_r, status) => {
      toast.success(
        status === 'active'
          ? 'Organization activated'
          : status === 'cancelled'
            ? 'Subscription cancelled'
            : 'Organization suspended',
      )
      void queryClient.invalidateQueries({ queryKey: ['organization', organizationId] })
      void queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to update status'),
  })

  const adminStatusMutation = useMutation({
    mutationFn: (vars: { user_id: string; status: 'ACTIVE' | 'INACTIVE' }) =>
      setAdminStatus({ data: { organization_id: organizationId, ...vars } }),
    onSuccess: (_r, vars) => {
      toast.success(
        vars.status === 'ACTIVE'
          ? 'Admin reactivated — they can sign in again.'
          : 'Admin deactivated — they can no longer sign in.',
      )
      void queryClient.invalidateQueries({ queryKey: ['organization', organizationId] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to update admin'),
  })

  if (isLoading || !data) {
    return <Skeleton className="h-64 w-full" />
  }

  const { organization: org, counts, admins } = data
  const isActive = org.subscription_status === 'active'

  return (
    <div>
      <Link
        to="/platform/organizations"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Organizations
      </Link>

      <PageHeader title={org.name}>
        <Button variant="outline" asChild>
          <Link
            to="/platform/organizations/$organizationId/data"
            params={{ organizationId }}
          >
            <Eye className="size-4" />
            View agency data
          </Link>
        </Button>
        <Button variant="outline" onClick={() => setEditOpen(true)}>
          <Pencil className="size-4" />
          Edit
        </Button>
        <Button
          variant={isActive ? 'outline' : 'default'}
          disabled={statusMutation.isPending}
          onClick={() => statusMutation.mutate(isActive ? 'suspended' : 'active')}
        >
          {isActive ? 'Suspend' : 'Activate'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">More actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Cancelled is an end state, distinct from Suspend's temporary
                lock-out — and the step the server requires before deletion. */}
            <DropdownMenuItem
              disabled={
                statusMutation.isPending ||
                org.subscription_status === 'cancelled'
              }
              onClick={() => statusMutation.mutate('cancelled')}
            >
              Cancel subscription
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleteOrgOpen(true)}
            >
              <Trash2 className="size-4" />
              Delete agency
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      <div className="mb-4">
        <StatusBadge status={org.subscription_status.toUpperCase()} />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Clients" value={counts.clients.toLocaleString()} />
        <StatCard label="Ad accounts" value={counts.adAccounts.toLocaleString()} />
        <StatCard
          label="Staff logins"
          hint="Admins and super admins"
          value={counts.staff.toLocaleString()}
        />
        <StatCard
          label="Portal logins"
          hint="Active client memberships"
          value={counts.portalLogins.toLocaleString()}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Subscription</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <InfoRow label="Plan" value={org.plan ?? '—'} />
              <InfoRow
                label="Status"
                value={<StatusBadge status={org.subscription_status.toUpperCase()} />}
              />
              <InfoRow label="Created" value={fmtDate(org.created_at)} />
              <InfoRow label="Suspended at" value={fmtDate(org.suspended_at)} />
              <InfoRow
                label="Notes"
                value={
                  org.notes ? (
                    <span className="whitespace-pre-wrap">{org.notes}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
            </dl>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="px-6 pt-6">
            <CardTitle className="text-base">Who to contact</CardTitle>
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => setAddAdminOpen(true)}>
                <Plus className="size-4" />
                Add admin
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Contact</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10 pr-6" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {admins.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                        <UserRound className="size-7 opacity-40" />
                        No admin logins — this agency can't sign in.
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-1"
                          onClick={() => setAddAdminOpen(true)}
                        >
                          <Plus className="size-4" />
                          Add their first admin
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {admins.map((a) => (
                  <TableRow key={a.user_id}>
                    <TableCell className="pl-6">
                      <div className="font-medium">{a.full_name}</div>
                      <div className="break-all text-xs text-muted-foreground">
                        {a.email}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.role}</TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      {/* Platform operators and your own account have no row
                          actions — neither should be revocable from an
                          agency's contact list. */}
                      {!a.is_platform_admin && a.user_id !== user.id && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8">
                              <MoreHorizontal className="size-4" />
                              <span className="sr-only">Actions for {a.full_name}</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={adminStatusMutation.isPending}
                              onClick={() =>
                                adminStatusMutation.mutate({
                                  user_id: a.user_id,
                                  status: a.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                                })
                              }
                            >
                              {a.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setAdminToDelete(a)}
                            >
                              Delete login
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Usage totals only. This agency's own clients, ledger and account records
        are not shown here — they are one deliberate click away under{' '}
        <strong>View agency data</strong>, and opening that is recorded in this
        agency's own audit log.
      </p>

      <EditOrganizationDialog
        organization={org}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <AddOrganizationAdminDialog
        organizationId={org.id}
        organizationName={org.name}
        open={addAdminOpen}
        onOpenChange={setAddAdminOpen}
      />
      <DeleteOrganizationDialog
        organization={org}
        counts={counts}
        open={deleteOrgOpen}
        onOpenChange={setDeleteOrgOpen}
      />
      <DeleteOrganizationAdminDialog
        admin={adminToDelete}
        organizationId={org.id}
        organizationName={org.name}
        isLastAdmin={admins.filter((a) => a.status === 'ACTIVE').length <= 1}
        open={adminToDelete !== null}
        onOpenChange={(o) => !o && setAdminToDelete(null)}
      />
    </div>
  )
}
