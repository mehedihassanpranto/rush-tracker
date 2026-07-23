import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ScrollText } from 'lucide-react'

import {
  auditFilterOptionsFn,
  listAuditLogsFn,
} from '@/server/audit/audit.fns'
import { actionLabel } from '@/components/dashboard/section'
import { PageHeader } from '@/components/shared/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const Route = createFileRoute('/admin/audit/')({
  component: AuditPage,
})

const ALL = 'ALL'

function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface Filters {
  action: string
  entity_type: string
  from: string
  to: string
}

const EMPTY: Filters = { action: ALL, entity_type: ALL, from: '', to: '' }

function AuditPage() {
  const listAudit = useServerFn(listAuditLogsFn)
  const getOptions = useServerFn(auditFilterOptionsFn)
  const [draft, setDraft] = useState<Filters>(EMPTY)
  const [applied, setApplied] = useState<Filters>(EMPTY)

  const { data: options } = useQuery({
    queryKey: ['audit', 'options'],
    queryFn: () => getOptions(),
  })

  const { data: logs, isLoading } = useQuery({
    queryKey: ['audit', 'logs', applied],
    queryFn: () =>
      listAudit({
        data: {
          action: applied.action === ALL ? undefined : applied.action,
          entity_type:
            applied.entity_type === ALL ? undefined : applied.entity_type,
          from: applied.from || undefined,
          to: applied.to || undefined,
        },
      }),
  })

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="Append-only record of sensitive operations (spec §55, §56)."
      />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <div className="space-y-1.5">
            <Label className="text-xs">Action</Label>
            <Select
              value={draft.action}
              onValueChange={(v) => setDraft((d) => ({ ...d, action: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All actions</SelectItem>
                {options?.actions.map((a) => (
                  <SelectItem key={a} value={a}>
                    {actionLabel(a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Entity</Label>
            <Select
              value={draft.entity_type}
              onValueChange={(v) => setDraft((d) => ({ ...d, entity_type: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All entities</SelectItem>
                {options?.entityTypes.map((e) => (
                  <SelectItem key={e} value={e}>
                    {e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setApplied(draft)}>Apply</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(EMPTY)
                setApplied(EMPTY)
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && (logs?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={4}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <ScrollText className="size-8 opacity-40" />
                    No audit entries match these filters.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {logs?.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDateTime(l.created_at)}
                </TableCell>
                <TableCell>{l.actor_name ?? 'System'}</TableCell>
                <TableCell className="font-medium">
                  {actionLabel(l.action)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <span>{l.entity_type}</span>
                  {l.entity_id && (
                    <span className="ml-1 font-mono text-xs opacity-70">
                      {l.entity_id.slice(0, 8)}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
