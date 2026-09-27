import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Bell } from 'lucide-react'

import {
  getNotificationLogSummaryFn,
  listNotificationEventsFn,
} from '@/server/platform/notification-log.fns'
import { labelForEventType } from '@/lib/telegram/event-types'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type StatusFilter = 'ALL' | 'sent' | 'failed' | 'skipped_no_subscription' | 'skipped_preference_off'

const STATUS_LABELS: Record<StatusFilter, string> = {
  ALL: 'All statuses',
  sent: 'Sent',
  failed: 'Failed',
  skipped_no_subscription: 'Skipped — not connected',
  skipped_preference_off: 'Skipped — muted',
}

const STATUS_BADGE_CLASS: Record<string, string> = {
  sent: 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  skipped_no_subscription:
    'border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  skipped_preference_off:
    'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
}

const RECIPIENT_LABELS: Record<string, string> = {
  platform_admin: 'Platform',
  agency: 'Agency',
  client: 'Client',
}

/**
 * Platform Management → Notifications: the delivery log every "Telegram
 * stopped working" report needs — a query, not a mystery. Read-only; nothing
 * here connects or disconnects a chat.
 */
export const Route = createFileRoute('/platform/notifications/')({
  component: PlatformNotificationsPage,
})

function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function PlatformNotificationsPage() {
  const getSummary = useServerFn(getNotificationLogSummaryFn)
  const listEvents = useServerFn(listNotificationEventsFn)
  const [status, setStatus] = useState<StatusFilter>('ALL')

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['notification-log-summary'],
    queryFn: () => getSummary(),
  })

  const { data: events, isLoading: eventsLoading } = useQuery({
    queryKey: ['notification-events', status],
    queryFn: () => listEvents({ data: { status } }),
  })

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Every Telegram send attempt across the platform — who's connected, and what did or didn't go out."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Connected chats"
          value={summary?.total_connected ?? '—'}
          loading={summaryLoading}
        />
        <StatCard
          label="Platform admins"
          value={summary?.by_recipient_type.platform_admin ?? '—'}
          loading={summaryLoading}
        />
        <StatCard
          label="Agencies"
          value={summary?.by_recipient_type.agency ?? '—'}
          loading={summaryLoading}
        />
        <StatCard
          label="Clients"
          value={summary?.by_recipient_type.client ?? '—'}
          loading={summaryLoading}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_LABELS) as Array<StatusFilter>).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {eventsLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}

            {!eventsLoading && (events?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Bell className="size-8 opacity-40" />
                    No notifications match this filter.
                  </div>
                </TableCell>
              </TableRow>
            )}

            {events?.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap">
                  {labelForEventType(e.event_type)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{RECIPIENT_LABELS[e.recipient_type]}</Badge>
                    <span className="truncate">{e.recipient_name ?? '—'}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={STATUS_BADGE_CLASS[e.status] ?? ''}
                  >
                    {STATUS_LABELS[e.status as StatusFilter] ?? e.status}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                  {e.error ?? '—'}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {fmtDateTime(e.sent_at ?? e.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
