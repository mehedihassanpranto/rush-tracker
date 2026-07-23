import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Bell, CheckCheck } from 'lucide-react'

import {
  listMyNotificationsFn,
  markAllNotificationsReadFn,
  markNotificationReadFn,
} from '@/server/notifications/notification.fns'
import { relativeTime } from '@/components/dashboard/section'
import { PageHeader } from '@/components/shared/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/portal/notifications/')({
  component: NotificationsPage,
})

function NotificationsPage() {
  const queryClient = useQueryClient()
  const getList = useServerFn(listMyNotificationsFn)
  const markRead = useServerFn(markNotificationReadFn)
  const markAll = useServerFn(markAllNotificationsReadFn)

  const { data: items, isLoading } = useQuery({
    queryKey: ['notifications', 'page'],
    queryFn: () => getList({ data: { limit: 100 } }),
  })

  const hasUnread = (items ?? []).some((n) => !n.read_at)

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }

  return (
    <div>
      <PageHeader title="Notifications" description="Updates on your requests, payments and accounts.">
        {hasUnread && (
          <Button
            variant="outline"
            onClick={async () => {
              await markAll()
              invalidate()
            }}
          >
            <CheckCheck className="size-4" />
            Mark all read
          </Button>
        )}
      </PageHeader>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (items?.length ?? 0) === 0 && (
        <Card className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
          <Bell className="size-8 opacity-40" />
          You have no notifications yet.
        </Card>
      )}

      <div className="space-y-2">
        {items?.map((n) => (
          <Card
            key={n.id}
            className={`flex items-start gap-3 p-4 ${
              n.read_at ? '' : 'border-primary/40 bg-primary/5'
            }`}
          >
            {!n.read_at && (
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{n.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {relativeTime(n.created_at)}
                </span>
              </div>
              {n.message && (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {n.message}
                </p>
              )}
            </div>
            {!n.read_at && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={async () => {
                  await markRead({ data: { id: n.id } })
                  invalidate()
                }}
              >
                Mark read
              </Button>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
