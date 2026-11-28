import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus, Users } from 'lucide-react'
import { toast } from 'sonner'

import {
  listMyTeamFn,
  setTeamMemberAccessFn,
  setTeamMemberStatusFn,
} from '@/server/team/team.fns'
import type { TeamMemberRow } from '@/server/team/team.fns'
import { currentMembership } from '@/lib/auth/types'
import {
  CLIENT_PERMISSIONS,
  clientCan,
  teamAccessRefusal,
  teamStatusRefusal,
} from '@/lib/permissions/client-permissions'
import { AccessSummary, EditAccessDialog } from '@/components/shared/portal-access'
import type { PortalAccess } from '@/components/shared/portal-access'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { AddTeamMemberDialog } from '@/components/client/add-team-member-dialog'
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

export const Route = createFileRoute('/client/team/')({
  component: TeamPage,
})

function TeamPage() {
  const { user } = Route.useRouteContext()
  const me = currentMembership(user)
  const canManage = clientCan(me, CLIENT_PERMISSIONS.TEAM_MANAGE)
  const actor = { userId: user.id, isOwner: me?.isOwner ?? false, permissions: me?.permissions ?? [] }
  // A Member who manages the team gives only what it has.
  const grantable = actor.isOwner ? undefined : actor.permissions

  const queryClient = useQueryClient()
  const listTeam = useServerFn(listMyTeamFn)
  const setStatus = useServerFn(setTeamMemberStatusFn)
  const setAccess = useServerFn(setTeamMemberAccessFn)
  const [addOpen, setAddOpen] = useState(false)
  const [accessFor, setAccessFor] = useState<TeamMemberRow | null>(null)

  const { data: team, isLoading } = useQuery({
    queryKey: ['my-team'],
    queryFn: () => listTeam(),
  })
  const activeOwners = (team ?? []).filter((m) => m.is_owner && m.membership_status === 'ACTIVE').length

  const statusMutation = useMutation({
    mutationFn: (input: { user_id: string; status: 'ACTIVE' | 'INACTIVE' }) =>
      setStatus({ data: input }),
    onSuccess: () => {
      toast.success('Status updated')
      void queryClient.invalidateQueries({ queryKey: ['my-team'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const accessMutation = useMutation({
    mutationFn: (input: { user_id: string } & PortalAccess) => setAccess({ data: input }),
    onSuccess: () => {
      toast.success('Access updated')
      void queryClient.invalidateQueries({ queryKey: ['my-team'] })
      setAccessFor(null)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  function target(m: TeamMemberRow) {
    return { userId: m.user_id, isOwner: m.is_owner, status: m.membership_status }
  }

  return (
    <div>
      <PageHeader
        title="Team"
        description="People on your team with access to this portal, and what each can do."
      >
        {canManage && (
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            Add team member
          </Button>
        )}
      </PageHeader>

      <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
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

            {!isLoading && (team?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Users className="size-8 opacity-40" />
                    No team members yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {team?.map((m) => {
              const nextStatus = m.membership_status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
              // Same rules the server applies; a refused action isn't offered.
              const canEditAccess =
                teamAccessRefusal(actor, target(m), { isOwner: m.is_owner, permissions: m.permissions }, activeOwners + 1) === null
              const statusRefusal = teamStatusRefusal(actor, target(m), nextStatus, activeOwners)
              return (
                <TableRow key={m.user_id}>
                  <TableCell className="font-medium">
                    {m.full_name}
                    {m.user_id === user.id && (
                      <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.email}</TableCell>
                  <TableCell>
                    <AccessSummary access={m} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={m.membership_status} />
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right whitespace-nowrap">
                      {canEditAccess && (
                        <Button size="sm" variant="ghost" onClick={() => setAccessFor(m)}>
                          Edit access
                        </Button>
                      )}
                      {statusRefusal === null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={statusMutation.isPending}
                          onClick={() => statusMutation.mutate({ user_id: m.user_id, status: nextStatus })}
                        >
                          {nextStatus === 'INACTIVE' ? 'Deactivate' : 'Activate'}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      <AddTeamMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        canMakeOwner={actor.isOwner}
        grantable={grantable}
      />
      <EditAccessDialog
        target={accessFor && { id: accessFor.user_id, name: accessFor.full_name || accessFor.email, access: accessFor }}
        onOpenChange={(o) => !o && setAccessFor(null)}
        onSave={(access) => accessFor && accessMutation.mutate({ user_id: accessFor.user_id, ...access })}
        saving={accessMutation.isPending}
        canMakeOwner={actor.isOwner}
        grantable={grantable}
      />
    </div>
  )
}
