import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus, Users } from 'lucide-react'
import { toast } from 'sonner'

import { listMyTeamFn, setTeamMemberStatusFn } from '@/server/team/team.fns'
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

export const Route = createFileRoute('/portal/team/')({
  component: TeamPage,
})

function TeamPage() {
  const queryClient = useQueryClient()
  const listTeam = useServerFn(listMyTeamFn)
  const setStatus = useServerFn(setTeamMemberStatusFn)
  const [addOpen, setAddOpen] = useState(false)

  const { data: team, isLoading } = useQuery({
    queryKey: ['my-team'],
    queryFn: () => listTeam(),
  })

  const statusMutation = useMutation({
    mutationFn: (input: { user_id: string; status: 'ACTIVE' | 'INACTIVE' }) =>
      setStatus({ data: input }),
    onSuccess: () => {
      toast.success('Status updated')
      void queryClient.invalidateQueries({ queryKey: ['my-team'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <div>
      <PageHeader
        title="Team"
        description="People on your team with access to this portal."
      >
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          Add team member
        </Button>
      </PageHeader>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (team?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={4}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Users className="size-8 opacity-40" />
                    No team members yet.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {team?.map((m) => (
              <TableRow key={m.user_id}>
                <TableCell className="font-medium">{m.full_name}</TableCell>
                <TableCell className="text-muted-foreground">{m.email}</TableCell>
                <TableCell>
                  <StatusBadge status={m.membership_status} />
                </TableCell>
                <TableCell className="text-right">
                  {m.membership_status === 'ACTIVE' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={statusMutation.isPending}
                      onClick={() =>
                        statusMutation.mutate({ user_id: m.user_id, status: 'INACTIVE' })
                      }
                    >
                      Deactivate
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={statusMutation.isPending}
                      onClick={() =>
                        statusMutation.mutate({ user_id: m.user_id, status: 'ACTIVE' })
                      }
                    >
                      Activate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <AddTeamMemberDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}
