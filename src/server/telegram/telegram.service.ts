import { getServerEnv } from '@/lib/env/env.server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { botKindFor } from '@/lib/telegram/recipients'
import type {
  TelegramBotKind,
  TelegramRecipient,
  TelegramRecipientType,
} from '@/lib/telegram/recipients'

/**
 * Multi-role Telegram notifications — TWO bots, per-recipient chats.
 *
 * Best-effort like notification.service.ts's notify(): called after the
 * primary write, never throws to the caller, never blocks or rolls back the
 * operation it's attached to. Every attempt (including "nobody has linked a
 * chat") is written to `notification_events`, so a delivery problem is a
 * query, not a mystery.
 *
 * THE ISOLATION RULE: a notification is addressed to exactly the recipient
 * the event belongs to — one agency's organization id, one client's id. The
 * only broadcast is `{ type: 'platform_admin' }`, which goes to every ACTIVE
 * platform admin. Never "every agency subscription" as a shortcut: that is
 * precisely how the old single-chat design leaked every agency's limit
 * requests into xRush's chat.
 *
 * THE SECOND RULE, added when the platform bot was split out: `platform_admin`
 * always talks to the PLATFORM bot (`TELEGRAM_PLATFORM_BOT_TOKEN`), `agency`
 * and `client` always talk to the SHARED bot (`TELEGRAM_BOT_TOKEN`) — see
 * `botKindFor()`. Every function here that touches the Bot API takes or
 * derives a `TelegramBotKind` rather than reading one global token, so it's
 * structurally impossible to send a platform notification through the bot
 * agencies and clients also use, or vice versa.
 *
 * Only the specific event sites that want a Telegram message call this — it
 * is deliberately not wired into notifyAdmins()/notify() globally.
 */

const API_TIMEOUT_MS = 8000

export interface TelegramApiResponse {
  ok: boolean
  result?: unknown
  description?: string
  error_code?: number
  parameters?: { migrate_to_chat_id?: number; retry_after?: number }
}

export function botToken(kind: TelegramBotKind): string | undefined {
  const env = getServerEnv()
  return kind === 'platform' ? env.TELEGRAM_PLATFORM_BOT_TOKEN : env.TELEGRAM_BOT_TOKEN
}

function envVarNameFor(kind: TelegramBotKind): string {
  return kind === 'platform' ? 'TELEGRAM_PLATFORM_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'
}

/** Raw Bot API call against one specific bot. Never throws — network errors
 * come back as ok:false. */
export async function telegramApi(
  method: string,
  body: Record<string, unknown> = {},
  kind: TelegramBotKind = 'shared',
): Promise<TelegramApiResponse> {
  const token = botToken(kind)
  if (!token) return { ok: false, description: `${envVarNameFor(kind)} not configured` }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    return (await res.json()) as TelegramApiResponse
  } catch (err) {
    return {
      ok: false,
      description: err instanceof Error ? err.message : 'Telegram request failed',
    }
  }
}

const cachedBotUsername: Partial<Record<TelegramBotKind, string>> = {}

/** That bot's @username (without the @), from getMe — cached per bot, per
 * instance. */
export async function getBotUsername(kind: TelegramBotKind = 'shared'): Promise<string | null> {
  if (cachedBotUsername[kind]) return cachedBotUsername[kind] as string
  const res = await telegramApi('getMe', {}, kind)
  const username = (res.result as { username?: string } | undefined)?.username
  if (res.ok && username) cachedBotUsername[kind] = username
  return cachedBotUsername[kind] ?? null
}

export async function sendTelegramText(
  chatId: string,
  text: string,
  kind: TelegramBotKind = 'shared',
): Promise<TelegramApiResponse> {
  return telegramApi(
    'sendMessage',
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    },
    kind,
  )
}

interface SubscriptionRow {
  id: string
  recipient_id: string
  telegram_chat_id: string
}

/** Resolve the recipient to the (recipient_id, organization_id) pairs to
 * deliver to. Platform admins are looked up live, so an account whose
 * platform flag was cleared stops receiving immediately even if its chat is
 * still linked. */
async function resolveRecipientIds(
  recipient: TelegramRecipient,
): Promise<Array<{ recipientId: string; organizationId: string | null }>> {
  const admin = getSupabaseAdminClient()
  switch (recipient.type) {
    case 'platform_admin': {
      const { data } = await admin
        .from('user_profiles')
        .select('user_id')
        .eq('status', 'ACTIVE')
        .eq('is_platform_admin', true)
      return ((data ?? []) as Array<{ user_id: string }>).map((r) => ({
        recipientId: r.user_id,
        organizationId: null,
      }))
    }
    case 'agency':
      return [{ recipientId: recipient.organizationId, organizationId: recipient.organizationId }]
    case 'client': {
      const { data } = await admin
        .from('clients')
        .select('organization_id')
        .eq('id', recipient.clientId)
        .maybeSingle()
      if (!data) return []
      return [
        {
          recipientId: recipient.clientId,
          organizationId: (data as { organization_id: string }).organization_id,
        },
      ]
    }
  }
}

async function logEvent(row: {
  event_type: string
  recipient_type: TelegramRecipientType
  recipient_id: string
  organization_id: string | null
  subscription_id?: string | null
  telegram_chat_id?: string | null
  payload?: Record<string, unknown> | null
  status: 'sent' | 'failed' | 'skipped_no_subscription' | 'skipped_preference_off'
  telegram_response?: unknown
}) {
  try {
    await getSupabaseAdminClient()
      .from('notification_events')
      .insert({
        ...row,
        sent_at: row.status === 'sent' ? new Date().toISOString() : null,
      })
  } catch (err) {
    console.error('[telegram] failed to log notification event', row.event_type, err)
  }
}

/**
 * Deliver one message to one subscription, handling the two Telegram
 * failures that otherwise break delivery silently and forever:
 *  - a group upgraded to a supergroup gets a NEW chat id (400 +
 *    migrate_to_chat_id) — follow it, persist it, retry once;
 *  - the bot was blocked / removed from the chat (403) — deactivate the
 *    subscription so the portal shows "Not connected" instead of a chat that
 *    silently receives nothing.
 */
async function deliver(
  sub: SubscriptionRow,
  text: string,
  kind: TelegramBotKind,
): Promise<TelegramApiResponse> {
  const admin = getSupabaseAdminClient()
  let res = await sendTelegramText(sub.telegram_chat_id, text, kind)

  const migratedTo = res.parameters?.migrate_to_chat_id
  if (!res.ok && migratedTo) {
    const newChatId = String(migratedTo)
    await admin
      .from('telegram_subscriptions')
      .update({ telegram_chat_id: newChatId })
      .eq('id', sub.id)
    sub.telegram_chat_id = newChatId
    res = await sendTelegramText(newChatId, text, kind)
  }

  if (!res.ok && res.error_code === 403) {
    await admin
      .from('telegram_subscriptions')
      .update({ is_active: false, unlinked_at: new Date().toISOString() })
      .eq('id', sub.id)
  }
  return res
}

export interface NotifyTelegramInput {
  /** Dotted event name, e.g. 'limit_request.created'. */
  eventType: string
  recipient: TelegramRecipient
  text: string
  /** Data the text was rendered from — stored for replay/debugging. */
  payload?: Record<string, unknown>
}

export async function notifyTelegram(input: NotifyTelegramInput): Promise<void> {
  try {
    const targets = await resolveRecipientIds(input.recipient)
    if (targets.length === 0) return
    const admin = getSupabaseAdminClient()
    const kind = botKindFor(input.recipient.type)

    for (const target of targets) {
      const { data } = await admin
        .from('telegram_subscriptions')
        .select('id, recipient_id, telegram_chat_id')
        .eq('recipient_type', input.recipient.type)
        .eq('recipient_id', target.recipientId)
        .eq('is_active', true)
      const subs = (data ?? []) as Array<SubscriptionRow>

      const base = {
        event_type: input.eventType,
        recipient_type: input.recipient.type,
        recipient_id: target.recipientId,
        organization_id: target.organizationId,
        payload: input.payload ?? null,
      }

      // A linked chat with no bot token still goes through deliver(), which
      // logs it as 'failed' with "<the right env var> not configured" — the
      // exact message someone debugging an outage needs to see.
      if (subs.length === 0) {
        await logEvent({ ...base, status: 'skipped_no_subscription' })
        continue
      }

      // Muted per-chat, per-event-type — a second, narrower filter on top of
      // the isolation rule above: this chat IS the right tenant, but whoever
      // manages it turned this specific event type off. One batched query for
      // the whole target's subs rather than one per subscription.
      const { data: muteRows } = await admin
        .from('telegram_notification_mutes')
        .select('subscription_id')
        .eq('event_type', input.eventType)
        .in(
          'subscription_id',
          subs.map((s) => s.id),
        )
      const muted = new Set(
        ((muteRows ?? []) as Array<{ subscription_id: string }>).map((m) => m.subscription_id),
      )

      for (const sub of subs) {
        if (muted.has(sub.id)) {
          await logEvent({
            ...base,
            subscription_id: sub.id,
            telegram_chat_id: sub.telegram_chat_id,
            status: 'skipped_preference_off',
          })
          continue
        }
        const res = await deliver(sub, input.text, kind)
        if (!res.ok) {
          console.error('[telegram] send failed', input.eventType, sub.id, res.description)
        }
        await logEvent({
          ...base,
          subscription_id: sub.id,
          telegram_chat_id: sub.telegram_chat_id,
          status: res.ok ? 'sent' : 'failed',
          telegram_response: res.ok ? { ok: true } : res,
        })
      }
    }
  } catch (err) {
    console.error('[telegram] notify failed', input.eventType, err)
  }
}
