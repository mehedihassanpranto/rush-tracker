import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'

import {
  getTelegramBotStatusFn,
  importLegacyTelegramChatFn,
  registerTelegramWebhookFn,
} from '@/server/telegram/telegram.fns'
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

/**
 * The bot's health, for the platform owner: is it configured, is the webhook
 * pointed at THIS deployment, what did Telegram last complain about, and
 * which recent sends failed. Everything the "it just stopped" outage needed
 * and nobody could see.
 */
export function TelegramBotStatusCard() {
  const queryClient = useQueryClient()
  const getStatus = useServerFn(getTelegramBotStatusFn)
  const register = useServerFn(registerTelegramWebhookFn)
  const importLegacy = useServerFn(importLegacyTelegramChatFn)

  const { data, isLoading } = useQuery({
    queryKey: ['telegram-bot-status'],
    queryFn: () => getStatus(),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['telegram-bot-status'] })
    void queryClient.invalidateQueries({ queryKey: ['telegram-connection'] })
  }

  const registerMutation = useMutation({
    mutationFn: () => register(),
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
          <CardTitle className="text-base">Bot and webhook</CardTitle>
          <CardDescription>
            One bot serves every recipient. Set TELEGRAM_BOT_TOKEN and
            TELEGRAM_WEBHOOK_SECRET on the deployment, then register the webhook
            so the bot can receive /start links.
          </CardDescription>
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
                  <span className="num">
                    {data.subscriptionCounts.platform_admin} platform ·{' '}
                    {data.subscriptionCounts.agency} agency ·{' '}
                    {data.subscriptionCounts.client} client
                  </span>
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
