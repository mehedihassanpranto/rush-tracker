import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { ExternalLink, Send, Unlink, Users } from 'lucide-react'
import { toast } from 'sonner'

import {
  createTelegramLinkFn,
  disconnectTelegramChatFn,
  getTelegramConnectionFn,
  sendTelegramTestFn,
} from '@/server/telegram/telegram.fns'
import type { TelegramScope } from '@/lib/telegram/recipients'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

const DESCRIPTIONS: Record<TelegramScope, string> = {
  platform:
    'Your own chat for platform-level events: new ad account requests from agencies, limit requests sent for platform review, and alerts on pool accounts no agency holds yet.',
  agency:
    "Your agency's chats — a DM or a team group — for your clients' limit requests and payments, the platform's decisions on your requests, accounts assigned to or withdrawn from you, and Meta disabled/low-balance alerts on your accounts.",
  client:
    'Updates on your own limit requests and payments, sent to your Telegram.',
}

/** Link freshness is 15 minutes server-side; poll for the /start to land
 * while a link is outstanding, then stop. */
const POLL_MS = 3000

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * "Connect Telegram" for any of the three portals. The server derives the
 * recipient from the caller's session — `scope` only picks which portal's
 * guard runs — so this component carries no ids at all.
 */
export function TelegramConnectCard({ scope }: { scope: TelegramScope }) {
  const queryClient = useQueryClient()
  const getConnection = useServerFn(getTelegramConnectionFn)
  const createLink = useServerFn(createTelegramLinkFn)
  const disconnect = useServerFn(disconnectTelegramChatFn)
  const sendTest = useServerFn(sendTelegramTestFn)
  const queryKey = ['telegram-connection', scope]

  const [pendingLink, setPendingLink] = useState<{
    url: string
    expiresAt: string
    chatCountAtStart: number
  } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => getConnection({ data: { scope } }),
    refetchInterval: pendingLink ? POLL_MS : false,
  })

  // A new chat appeared (or the link expired) — the link has done its job.
  useEffect(() => {
    if (!pendingLink || !data) return
    if (data.chats.length > pendingLink.chatCountAtStart) {
      setPendingLink(null)
      toast.success('Telegram connected')
    } else if (new Date(pendingLink.expiresAt).getTime() < Date.now()) {
      setPendingLink(null)
    }
  }, [data, pendingLink])

  const linkMutation = useMutation({
    mutationFn: (target: 'private' | 'group') =>
      createLink({ data: { scope, target } }),
    onSuccess: (res) => {
      setPendingLink({ ...res, chatCountAtStart: data?.chats.length ?? 0 })
      window.open(res.url, '_blank', 'noopener,noreferrer')
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not create a link'),
  })

  const disconnectMutation = useMutation({
    mutationFn: (subscriptionId: string) =>
      disconnect({ data: { scope, subscription_id: subscriptionId } }),
    onSuccess: () => {
      toast.success('Chat disconnected')
      void queryClient.invalidateQueries({ queryKey })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect'),
  })

  const testMutation = useMutation({
    mutationFn: () => sendTest({ data: { scope } }),
    onSuccess: (res) => {
      if (res.failed === 0) toast.success('Test message sent')
      else toast.error(`Test failed${res.error ? `: ${res.error}` : ''}`)
      void queryClient.invalidateQueries({ queryKey })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to send test'),
  })

  const chats = data?.chats ?? []
  const available = data?.available ?? false

  return (
    <div className="mb-6 sm:max-w-lg">
      <h2 className="mb-2 text-sm font-semibold">Notifications</h2>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Telegram
            {data && (
              <Badge variant={chats.length > 0 ? 'secondary' : 'outline'}>
                {chats.length > 0 ? 'Connected' : 'Not connected'}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>{DESCRIPTIONS[scope]}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading && <Skeleton className="h-16 w-full" />}

          {data && !available && (
            <p className="text-sm text-muted-foreground">
              {scope === 'platform'
                ? 'The Telegram bot is not configured yet — see Telegram bot below.'
                : 'Telegram is not available on Rush Tracker yet.'}
            </p>
          )}

          {chats.length > 0 && (
            <ul className="divide-y rounded-md border">
              {chats.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {c.telegram_chat_title ??
                        (c.telegram_username ? `@${c.telegram_username}` : 'Telegram chat')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {c.telegram_chat_title ? 'Group' : 'Direct message'} · linked{' '}
                      {fmtDate(c.linked_at)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disconnectMutation.isPending}
                    onClick={() => disconnectMutation.mutate(c.id)}
                  >
                    <Unlink className="size-4" />
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {pendingLink && (
            <div className="rounded-md border border-dashed p-3 text-sm">
              <p>
                Telegram should have opened — tap <strong>Start</strong> there (or
                pick the group to add the bot to). This page updates on its own.
              </p>
              <a
                href={pendingLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 break-all text-xs"
              >
                Open the link again <ExternalLink className="size-3" />
              </a>
              <p className="mt-1 text-xs text-muted-foreground">
                Single-use, expires in 15 minutes.
              </p>
            </div>
          )}

          {available && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={linkMutation.isPending}
                onClick={() => linkMutation.mutate('private')}
              >
                <Send className="size-4" />
                {chats.length > 0 ? 'Connect another chat' : 'Connect Telegram'}
              </Button>
              {scope !== 'client' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={linkMutation.isPending}
                  onClick={() => linkMutation.mutate('group')}
                >
                  <Users className="size-4" />
                  Connect a group
                </Button>
              )}
              {chats.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={testMutation.isPending}
                  onClick={() => testMutation.mutate()}
                >
                  Send test message
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
