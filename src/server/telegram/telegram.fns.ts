import { createServerFn } from '@tanstack/react-start'
import { getRequestUrl } from '@tanstack/react-start/server'
import { z } from 'zod'

import { getServerEnv } from '@/lib/env/env.server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { DEPLOYMENT_ORGANIZATION_ID } from '@/lib/organizations/deployment-org'
import {
  requireAdmin,
  requireClientMembership,
  requirePlatformAdmin,
} from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { telegramDeepLink } from '@/lib/telegram/recipients'
import type { TelegramScope } from '@/lib/telegram/recipients'
import {
  getBotUsername,
  notifyTelegram,
  telegramApi,
} from './telegram.service'
import { createLinkToken } from './telegram-link.service'
import type { RecipientColumns } from './telegram-link.service'

/**
 * Connect / disconnect Telegram, from each of the three portals.
 *
 * The recipient is ALWAYS derived from the caller's own session — never
 * accepted as input: a platform admin links their own chat, an agency admin
 * links their own organization, a client member links the client they are
 * currently viewing. `scope` only says which of those the caller is asking
 * for, and each one has its own guard.
 *
 * Agency linking needs `integrations.manage` (SUPER_ADMIN by default): a
 * linked chat receives client names and amounts, so adding one is an
 * exfiltration channel and is gated like the Meta credentials on the same
 * screen. Any active client member may link their client, matching the
 * no-tiers model of Team Members.
 */

const scopeSchema = z.object({ scope: z.enum(['platform', 'agency', 'client']) })

interface ResolvedScope {
  actorId: string
  auditOrganizationId: string
  columns: RecipientColumns
}

async function resolveScope(scope: TelegramScope): Promise<ResolvedScope> {
  if (scope === 'platform') {
    const user = await requirePlatformAdmin()
    return {
      actorId: user.id,
      auditOrganizationId: user.organizationId,
      columns: {
        recipient_type: 'platform_admin',
        recipient_id: user.id,
        platform_user_id: user.id,
        organization_id: null,
        client_id: null,
      },
    }
  }
  if (scope === 'agency') {
    const user = await requireAdmin(PERMISSIONS.INTEGRATIONS_MANAGE)
    return {
      actorId: user.id,
      auditOrganizationId: user.organizationId,
      columns: {
        recipient_type: 'agency',
        recipient_id: user.organizationId,
        platform_user_id: null,
        organization_id: user.organizationId,
        client_id: null,
      },
    }
  }
  const { user, membership } = await requireClientMembership()
  return {
    actorId: user.id,
    auditOrganizationId: user.organizationId,
    columns: {
      recipient_type: 'client',
      recipient_id: membership.clientId,
      platform_user_id: null,
      organization_id: user.organizationId,
      client_id: membership.clientId,
    },
  }
}

export interface TelegramChatLink {
  id: string
  telegram_username: string | null
  telegram_chat_title: string | null
  linked_at: string
}

export interface TelegramConnection {
  /** Bot token set AND the webhook secret set — linking can work at all. */
  available: boolean
  chats: Array<TelegramChatLink>
}

export const getTelegramConnectionFn = createServerFn({ method: 'GET' })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<TelegramConnection> => {
    const { columns } = await resolveScope(data.scope)
    const env = getServerEnv()
    const { data: rows, error } = await getSupabaseAdminClient()
      .from('telegram_subscriptions')
      .select('id, telegram_username, telegram_chat_title, linked_at')
      .eq('recipient_type', columns.recipient_type)
      .eq('recipient_id', columns.recipient_id)
      .eq('is_active', true)
      .order('linked_at', { ascending: false })
    if (error) throw new Error(error.message)
    return {
      available: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET),
      chats: (rows ?? []) as Array<TelegramChatLink>,
    }
  })

export const createTelegramLinkFn = createServerFn({ method: 'POST' })
  .validator(scopeSchema.extend({ target: z.enum(['private', 'group']) }))
  .handler(async ({ data }): Promise<{ url: string; expiresAt: string }> => {
    const { actorId, columns } = await resolveScope(data.scope)
    const env = getServerEnv()
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
      throw new Error('Telegram is not set up on Rush Tracker yet. Contact the platform owner.')
    }
    const username = await getBotUsername()
    if (!username) {
      throw new Error('Could not reach the Telegram bot. Try again in a moment.')
    }
    const { token, expiresAt } = await createLinkToken(columns, actorId)
    return { url: telegramDeepLink(username, token, data.target), expiresAt }
  })

export const disconnectTelegramChatFn = createServerFn({ method: 'POST' })
  .validator(scopeSchema.extend({ subscription_id: z.uuid() }))
  .handler(async ({ data }) => {
    const { actorId, auditOrganizationId, columns } = await resolveScope(data.scope)
    // Scoped to the caller's own recipient as well as the id, so one tenant
    // cannot disconnect another's chat by guessing a subscription id.
    const { data: row, error } = await getSupabaseAdminClient()
      .from('telegram_subscriptions')
      .update({ is_active: false, unlinked_at: new Date().toISOString() })
      .eq('id', data.subscription_id)
      .eq('recipient_type', columns.recipient_type)
      .eq('recipient_id', columns.recipient_id)
      .eq('is_active', true)
      .select('id, telegram_chat_id, telegram_username, telegram_chat_title')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) throw new Error('Chat not found')

    await writeAudit({
      actorUserId: actorId,
      organizationId: auditOrganizationId,
      action: 'TELEGRAM_DISCONNECTED',
      entityType: 'TELEGRAM_SUBSCRIPTION',
      entityId: data.subscription_id,
      oldValues: {
        recipient_type: columns.recipient_type,
        recipient_id: columns.recipient_id,
        telegram_username: (row as { telegram_username: string | null }).telegram_username,
        telegram_chat_title: (row as { telegram_chat_title: string | null }).telegram_chat_title,
      },
    })
    return { ok: true }
  })

export const sendTelegramTestFn = createServerFn({ method: 'POST' })
  .validator(scopeSchema)
  .handler(async ({ data }) => {
    const { columns } = await resolveScope(data.scope)
    // Platform admins are a broadcast recipient; a test should reach only the
    // caller's own chat, so it's addressed by id directly below instead of
    // through the broadcast.
    const admin = getSupabaseAdminClient()
    const { data: subs } = await admin
      .from('telegram_subscriptions')
      .select('id')
      .eq('recipient_type', columns.recipient_type)
      .eq('recipient_id', columns.recipient_id)
      .eq('is_active', true)
    if (!subs || subs.length === 0) throw new Error('No Telegram chat is connected')

    const before = new Date().toISOString()
    const text = '🧪 Test message from Rush Tracker — notifications are working.'
    if (columns.recipient_type === 'platform_admin') {
      await notifyTelegramToUser(columns.recipient_id, text)
    } else {
      await notifyTelegram({
        eventType: 'test',
        recipient:
          columns.recipient_type === 'agency'
            ? { type: 'agency', organizationId: columns.recipient_id }
            : { type: 'client', clientId: columns.recipient_id },
        text,
      })
    }

    // Report the real outcome from the delivery log, not an optimistic "sent".
    const { data: events } = await admin
      .from('notification_events')
      .select('status, telegram_response')
      .eq('event_type', 'test')
      .eq('recipient_id', columns.recipient_id)
      .gte('created_at', before)
    const rows = (events ?? []) as Array<{
      status: string
      telegram_response: { description?: string } | null
    }>
    const failed = rows.filter((r) => r.status !== 'sent')
    return {
      sent: rows.length - failed.length,
      failed: failed.length,
      error: failed[0]?.telegram_response?.description ?? null,
    }
  })

/** One platform admin's own chats only — used by the test message. */
async function notifyTelegramToUser(userId: string, text: string) {
  const admin = getSupabaseAdminClient()
  const { data: subs } = await admin
    .from('telegram_subscriptions')
    .select('id, telegram_chat_id')
    .eq('recipient_type', 'platform_admin')
    .eq('recipient_id', userId)
    .eq('is_active', true)
  for (const sub of (subs ?? []) as Array<{ id: string; telegram_chat_id: string }>) {
    const res = await telegramApi('sendMessage', { chat_id: sub.telegram_chat_id, text })
    await admin.from('notification_events').insert({
      event_type: 'test',
      recipient_type: 'platform_admin',
      recipient_id: userId,
      subscription_id: sub.id,
      telegram_chat_id: sub.telegram_chat_id,
      status: res.ok ? 'sent' : 'failed',
      telegram_response: res.ok ? { ok: true } : res,
      sent_at: res.ok ? new Date().toISOString() : null,
    })
  }
}

// --- Platform: bot diagnostics ----------------------------------------------

export interface TelegramBotStatus {
  tokenConfigured: boolean
  webhookSecretConfigured: boolean
  webhookSecretValid: boolean
  botUsername: string | null
  /** What getMe/getWebhookInfo said, verbatim, when the token is set. */
  apiError: string | null
  expectedWebhookUrl: string
  webhook: {
    url: string
    pending_update_count: number
    last_error_date: string | null
    last_error_message: string | null
  } | null
  legacyChatConfigured: boolean
  legacyChatImported: boolean
  subscriptionCounts: Record<'platform_admin' | 'agency' | 'client', number>
  recentFailures: Array<{
    id: string
    event_type: string
    recipient_type: string
    created_at: string
    error: string | null
  }>
}

const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/

function expectedWebhookUrl(): string {
  return `${getRequestUrl().origin}/api/telegram/webhook`
}

export const getTelegramBotStatusFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<TelegramBotStatus> => {
    await requirePlatformAdmin()
    const env = getServerEnv()
    const admin = getSupabaseAdminClient()

    let botUsername: string | null = null
    let apiError: string | null = null
    let webhook: TelegramBotStatus['webhook'] = null
    if (env.TELEGRAM_BOT_TOKEN) {
      const me = await telegramApi('getMe')
      if (me.ok) {
        botUsername = (me.result as { username?: string }).username ?? null
        const info = await telegramApi('getWebhookInfo')
        if (info.ok) {
          const r = info.result as {
            url: string
            pending_update_count: number
            last_error_date?: number
            last_error_message?: string
          }
          webhook = {
            url: r.url,
            pending_update_count: r.pending_update_count,
            last_error_date: r.last_error_date
              ? new Date(r.last_error_date * 1000).toISOString()
              : null,
            last_error_message: r.last_error_message ?? null,
          }
        } else {
          apiError = info.description ?? 'getWebhookInfo failed'
        }
      } else {
        apiError = me.description ?? 'getMe failed'
      }
    }

    const { data: subs } = await admin
      .from('telegram_subscriptions')
      .select('recipient_type, recipient_id, telegram_chat_id')
      .eq('is_active', true)
    const subRows = (subs ?? []) as Array<{
      recipient_type: 'platform_admin' | 'agency' | 'client'
      recipient_id: string
      telegram_chat_id: string
    }>
    const subscriptionCounts = { platform_admin: 0, agency: 0, client: 0 }
    for (const s of subRows) subscriptionCounts[s.recipient_type]++

    const { data: failures } = await admin
      .from('notification_events')
      .select('id, event_type, recipient_type, created_at, telegram_response')
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(10)

    return {
      tokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
      webhookSecretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
      webhookSecretValid: WEBHOOK_SECRET_PATTERN.test(env.TELEGRAM_WEBHOOK_SECRET ?? ''),
      botUsername,
      apiError,
      expectedWebhookUrl: expectedWebhookUrl(),
      webhook,
      legacyChatConfigured: Boolean(env.TELEGRAM_CHAT_ID),
      legacyChatImported: subRows.some(
        (s) =>
          s.recipient_type === 'agency' &&
          s.recipient_id === DEPLOYMENT_ORGANIZATION_ID &&
          s.telegram_chat_id === env.TELEGRAM_CHAT_ID,
      ),
      subscriptionCounts,
      recentFailures: (
        (failures ?? []) as Array<{
          id: string
          event_type: string
          recipient_type: string
          created_at: string
          telegram_response: { description?: string } | null
        }>
      ).map((f) => ({
        id: f.id,
        event_type: f.event_type,
        recipient_type: f.recipient_type,
        created_at: f.created_at,
        error: f.telegram_response?.description ?? null,
      })),
    }
  },
)

export const registerTelegramWebhookFn = createServerFn({ method: 'POST' }).handler(
  async () => {
    const actor = await requirePlatformAdmin()
    const env = getServerEnv()
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set')
    if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error('TELEGRAM_WEBHOOK_SECRET is not set')
    if (!WEBHOOK_SECRET_PATTERN.test(env.TELEGRAM_WEBHOOK_SECRET)) {
      throw new Error(
        'TELEGRAM_WEBHOOK_SECRET may only contain A–Z, a–z, 0–9, _ and - (max 256). Try `openssl rand -hex 32`.',
      )
    }
    const url = expectedWebhookUrl()
    if (!url.startsWith('https://')) {
      throw new Error(`Telegram only accepts HTTPS webhooks — this deployment is at ${url}`)
    }
    const res = await telegramApi('setWebhook', {
      url,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'my_chat_member'],
    })
    if (!res.ok) throw new Error(res.description ?? 'setWebhook failed')

    await writeAudit({
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      action: 'TELEGRAM_WEBHOOK_REGISTERED',
      entityType: 'PLATFORM_SETTINGS',
      newValues: { url },
    })
    return { url }
  },
)

/**
 * One-time migration of the old single deployment chat (TELEGRAM_CHAT_ID)
 * into xRush Agency's own agency subscription (spec §8.1), so it keeps
 * receiving without re-linking. Idempotent.
 *
 * It becomes an AGENCY chat, not a platform one: everything it used to get
 * was xRush's own agency activity (its limit requests, its accounts' Meta
 * alerts). It also used to get every OTHER agency's limit requests — the leak
 * this redesign closes — and that deliberately does not carry over.
 */
export const importLegacyTelegramChatFn = createServerFn({ method: 'POST' }).handler(
  async () => {
    const actor = await requirePlatformAdmin()
    const chatId = getServerEnv().TELEGRAM_CHAT_ID
    if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set — nothing to import')

    const { data, error } = await getSupabaseAdminClient()
      .from('telegram_subscriptions')
      .upsert(
        {
          recipient_type: 'agency',
          recipient_id: DEPLOYMENT_ORGANIZATION_ID,
          organization_id: DEPLOYMENT_ORGANIZATION_ID,
          telegram_chat_id: chatId,
          linked_by: actor.id,
          linked_at: new Date().toISOString(),
          is_active: true,
          unlinked_at: null,
        },
        { onConflict: 'recipient_type,recipient_id,telegram_chat_id' },
      )
      .select('id')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      organizationId: DEPLOYMENT_ORGANIZATION_ID,
      action: 'TELEGRAM_CONNECTED',
      entityType: 'TELEGRAM_SUBSCRIPTION',
      entityId: (data as { id: string }).id,
      newValues: { recipient_type: 'agency', source: 'LEGACY_ENV_IMPORT' },
    })
    return { ok: true }
  },
)
