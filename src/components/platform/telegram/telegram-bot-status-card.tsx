import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'

import {
  getTelegramBotStatusFn,
  importLegacyTelegramChatFn,
  registerTelegramWebhookFn,
} from '@/server/telegram/telegram.fns'
import type { TelegramBotKind } from '@/lib/telegram/recipients'
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

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  )
}

function Ok({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <Badge variant={ok ? 'secondary' : 'destructive'}>{ok ? yes : no}</Badge>
}

const TITLES: Record<TelegramBotKind, string> = {
  shared: 'Shared bot (agency + client)',
  platform: 'Platform bot (platform admins only)',
}

const DESCRIPTIONS: Record<TelegramBotKind, string> = {
  shared:
    'Serves every agency and client chat. Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET on the deployment, then register the webhook so the bot can receive /start links.',
  platform:
    'A separate bot for platform-admin chats only, deliberately never shared with any agency or client. Set TELEGRAM_PLATFORM_BOT_TOKEN (TELEGRAM_WEBHOOK_SECRET is shared with the bot above), then register this bot\'s own webhook.',
}

const LINKED_CHATS_LABEL: Record<TelegramBotKind, (data: {
  subscriptionCounts: Record<'platform_admin' | 'agency' | 'client', number>
}) => string> = {
  shared: (d) => `${d.subscriptionCounts.agency} agency · ${d.subscriptionCounts.client} client`,
  platform: (d) => `${d.subscriptionCounts.platform_admin} platform admin`,
}

/**
 * One bot's health, for the platform owner: is it configured, is the webhook
 * pointed at THIS deployment, what did Telegram last complain about, and
 * which recent sends failed. Everything the "it just stopped" outage needed
 * and nobody could see. Rendered twice on Platform Settings — once per bot,
 * since the two are independent (each can be configured, healthy, or broken
 * without affecting the other).
 */
export function TelegramBotStatusCard({ kind }: { kind: TelegramBotKind }) {
  const queryClient = useQueryClient()
  const getStatus = useServerFn(getTelegramBotStatusFn)
  const register = useServerFn(registerTelegramWebhookFn)
  const importLegacy = useServerFn(importLegacyTelegramChatFn)
  const queryKey = ['telegram-bot-status', kind]

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => getStatus({ data: { kind } }),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey })
    void queryClient.invalidateQueries({ queryKey: ['telegram-connection'] })
  }

  const registerMutation = useMutation({
    mutationFn: () => register({ data: { kind } }),
    onSuccess: (res) => {
      toast.success(`Webhook registered: ${res.url}`)
      refresh()
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to register webhook'),
  })

  const importMutation = useMutation({
    mutationFn: () => importLegacy(),
    onSuccess: () => {
      toast.success("Legacy chat is now xRush Agency's agency chat")
      refresh()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Import failed'),
  })

  const webhookMatches =
    data?.webhook != null && data.webhook.url === data.expectedWebhookUrl

  return (
    <div className="mb-6 sm:max-w-lg">
      <h2 className="mb-2 text-sm font-semibold">Telegram bot</h2>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{TITLES[kind]}</CardTitle>
          <CardDescription>{DESCRIPTIONS[kind]}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading && <Skeleton className="h-32 w-full" />}
          {data && (
            <>
              <dl className="divide-y">
                <Row label="Bot token">
                  <Ok ok={data.tokenConfigured} yes="Set" no="Missing" />
                </Row>
                <Row label="Bot">
                  {data.botUsername ? `@${data.botUsername}` : '—'}
                </Row>
                {data.apiError && (
                  <Row label="Telegram said">
                    <span className="text-destructive">{data.apiError}</span>
                  </Row>
                )}
                <Row label="Webhook secret">
                  <Ok
                    ok={data.webhookSecretConfigured && data.webhookSecretValid}
                    yes="Set"
                    no={data.webhookSecretConfigured ? 'Invalid characters' : 'Missing'}
                  />
                </Row>
                <Row label="Webhook">
                  {data.webhook ? (
                    <span className="flex flex-col items-end gap-1">
                      <Ok
                        ok={webhookMatches}
                        yes="Pointing here"
                        no={data.webhook.url ? 'Points elsewhere' : 'Not registered'}
                      />
                      {data.webhook.url && !webhookMatches && (
                        <span className="font-mono text-xs">{data.webhook.url}</span>
                      )}
                    </span>
                  ) : (
                    '—'
                  )}
                </Row>
                {data.webhook?.last_error_message && (
                  <Row label="Last webhook error">
                    <span className="text-destructive">
                      {data.webhook.last_error_message}
                      {data.webhook.last_error_date &&
                        ` (${fmtDateTime(data.webhook.last_error_date)})`}
                    </span>
                  </Row>
                )}
                <Row label="Linked chats">
                  <span className="num">{LINKED_CHATS_LABEL[kind](data)}</span>
                </Row>
                {data.legacyChatConfigured && (
                  <Row label="Legacy TELEGRAM_CHAT_ID">
                    {data.legacyChatImported ? (
                      <Badge variant="secondary">Imported — safe to remove</Badge>
                    ) : (
                      <Badge variant="outline">Not imported</Badge>
                    )}
                  </Row>
                )}
              </dl>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!data.tokenConfigured || registerMutation.isPending}
                  onClick={() => registerMutation.mutate()}
                >
                  {webhookMatches ? 'Re-register webhook' : 'Register webhook'}
                </Button>
                {data.legacyChatConfigured && !data.legacyChatImported && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={importMutation.isPending}
                    onClick={() => importMutation.mutate()}
                  >
                    Import legacy chat
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={refresh}>
                  Refresh
                </Button>
              </div>
              {data.legacyChatConfigured && !data.legacyChatImported && (
                <p className="text-xs text-muted-foreground">
                  The old single chat no longer receives anything by itself.
                  Importing makes it xRush Agency's agency chat, so it keeps
                  getting xRush's own alerts — but no longer other agencies'
                  limit requests.
                </p>
              )}

              {data.recentFailures.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
                    Recent failed sends
                  </h3>
                  <ul className="divide-y rounded-md border text-xs">
                    {data.recentFailures.map((f) => (
                      <li key={f.id} className="px-3 py-2">
                        <div className="flex justify-between gap-2">
                          <span className="font-mono">{f.event_type}</span>
                          <span className="text-muted-foreground">
                            {fmtDateTime(f.created_at)}
                          </span>
                        </div>
                        <div className="text-muted-foreground">
                          → {f.recipient_type}: {f.error ?? 'unknown error'}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
