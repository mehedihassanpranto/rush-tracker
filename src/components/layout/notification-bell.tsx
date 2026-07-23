import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Bell, CheckCheck } from 'lucide-react'

import {
  listMyNotificationsFn,
  markAllNotificationsReadFn,
  markNotificationReadFn,
  unreadNotificationCountFn,
} from '@/server/notifications/notification.fns'
import { relativeTime } from '@/components/dashboard/section'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { RoleKey } from '@/lib/auth/types'

export function NotificationBell({ role }: { role: RoleKey }) {
  const queryClient = useQueryClient()
  const getCount = useServerFn(unreadNotificationCountFn)
  const getList = useServerFn(listMyNotificationsFn)
  const markRead = useServerFn(markNotificationReadFn)
  const markAll = useServerFn(markAllNotificationsReadFn)
  const isClient = role === 'CLIENT'

  const { data: countData } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => getCount(),
    refetchInterval: 60_000,
  })
  const { data: items } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => getList({ data: { limit: 15 } }),
  })

  const unread = countData?.count ?? 0

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }

  async function onItemClick(id: string, readAt: string | null) {
    if (readAt) return
    await markRead({ data: { id } })
    invalidate()
  }

  async function onMarkAll() {
    await markAll()
    invalidate()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="size-5" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-4 text-primary-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
          <span className="sr-only">Notifications</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={onMarkAll}
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto">
          {(items?.length ?? 0) === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No notifications.
            </div>
          ) : (
            <ul className="divide-y">
              {items?.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => void onItemClick(n.id, n.read_at)}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left hover:bg-muted/60"
                  >
                    <span className="flex w-full items-center gap-2">
                      {!n.read_at && (
                        <span className="size-2 shrink-0 rounded-full bg-primary" />
                      )}
                      <span className="flex-1 text-sm font-medium">
                        {n.title}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {relativeTime(n.created_at)}
                      </span>
                    </span>
                    {n.message && (
                      <span className="pl-4 text-xs text-muted-foreground">
                        {n.message}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {isClient && (
          <div className="border-t px-3 py-2 text-center">
            <Link
              to="/portal/notifications"
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              View all notifications
            </Link>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
