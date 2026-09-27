import { createHash, randomBytes } from 'node:crypto'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { writeAudit } from '@/server/audit/audit.service'
import { parseStartToken } from '@/lib/telegram/recipients'
import type { TelegramRecipientType } from '@/lib/telegram/recipients'
import { sendTelegramText } from './telegram.service'

/**
 * Chat-linking half of the Telegram integration: minting single-use /start
 * tokens, and handling the updates Telegram POSTs to /api/telegram/webhook.
 *
 * Plain service module, used only from handler bodies (the webhook route and
 * telegram.fns.ts) — never re-exported from a .fns.ts file, for the same
 * bundler reason as limit-request-approval.service.ts.
 */

export const LINK_TOKEN_TTL_MINUTES = 15

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The typed FK columns every subscription/token row carries alongside the
 * generic recipient_id (see migration 000047's CHECK constraint). */
export interface RecipientColumns {
  recipient_type: TelegramRecipientType
  recipient_id: string
  platform_user_id: string | null
  organization_id: string | null
  client_id: string | null
}

/** Mint a token for `recipient`, store only its hash, return the raw value. */
export async function createLinkToken(
  recipient: RecipientColumns,
  createdBy: string,
): Promise<{ token: string; expiresAt: string }> {
  const admin = getSupabaseAdminClient()
  // 24 random bytes -> 32 base64url chars: inside Telegram's 64-char,
  // [A-Za-z0-9_-] limit for start parameters.
  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MINUTES * 60_000).toISOString()

  // Housekeeping: expired or used tokens for this recipient are dead weight.
  await admin
    .from('telegram_link_requests')
    .delete()
    .eq('recipient_type', recipient.recipient_type)
    .eq('recipient_id', recipient.recipient_id)
    .or(`consumed_at.not.is.null,expires_at.lt.${new Date().toISOString()}`)

  const { error } = await admin.from('telegram_link_requests').insert({
    ...recipient,
    token_hash: hashLinkToken(token),
    created_by: createdBy,
    expires_at: expiresAt,
  })
  if (error) throw new Error(error.message)
  return { token, expiresAt }
}

// --- Webhook update handling ------------------------------------------------

interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
}

interface TelegramUpdate {
  message?: {
    text?: string
    chat: TelegramChat
    from?: { username?: string }
    migrate_to_chat_id?: number
  }
  my_chat_member?: {
    chat: TelegramChat
    new_chat_member: { status: string }
  }
}

async function reply(chatId: number | string, text: string) {
  await sendTelegramText(String(chatId), text)
}

/** Display name for the confirmation message — what the chat will now
 * receive notifications about. Null means the recipient no longer exists or
 * is no longer allowed to link (e.g. platform flag cleared since). */
async function recipientLabel(
  row: RecipientColumns,
): Promise<{ label: string; auditOrganizationId: string } | null> {
  const admin = getSupabaseAdminClient()
  if (row.recipient_type === 'platform_admin') {
    const { data } = await admin
      .from('user_profiles')
      .select('organization_id, is_platform_admin, status')
      .eq('user_id', row.recipient_id)
      .maybeSingle()
    const p = data as { organization_id: string; is_platform_admin: boolean; status: string } | null
    if (!p || !p.is_platform_admin || p.status !== 'ACTIVE') return null
    return { label: 'Rush Tracker platform', auditOrganizationId: p.organization_id }
  }
  if (row.recipient_type === 'agency') {
    const { data } = await admin
      .from('organizations')
      .select('name')
      .eq('id', row.recipient_id)
      .maybeSingle()
    if (!data) return null
    return { label: (data as { name: string }).name, auditOrganizationId: row.recipient_id }
  }
  const { data } = await admin
    .from('clients')
    .select('name, organization_id')
    .eq('id', row.recipient_id)
    .maybeSingle()
  if (!data) return null
  const c = data as { name: string; organization_id: string }
  return { label: c.name, auditOrganizationId: c.organization_id }
}

async function handleStart(
  chat: TelegramChat,
  fromUsername: string | undefined,
  token: string,
) {
  const admin = getSupabaseAdminClient()
  const now = new Date().toISOString()

  // Consume atomically: the conditional UPDATE is the guard, so two chats
  // racing on one forwarded link cannot both win.
  const { data: consumed } = await admin
    .from('telegram_link_requests')
    .update({ consumed_at: now })
    .eq('token_hash', hashLinkToken(token))
    .is('consumed_at', null)
    .gt('expires_at', now)
    .select('recipient_type, recipient_id, platform_user_id, organization_id, client_id, created_by')
    .maybeSingle()

  if (!consumed) {
    await reply(
      chat.id,
      'This link has expired or was already used. Open Rush Tracker and choose "Connect Telegram" again to get a new one.',
    )
    return
  }
  const row = consumed as RecipientColumns & { created_by: string }
  const resolved = await recipientLabel(row)
  if (!resolved) {
    await reply(chat.id, 'This link is no longer valid. Nothing was connected.')
    return
  }

  const { data: sub, error } = await admin
    .from('telegram_subscriptions')
    .upsert(
      {
        recipient_type: row.recipient_type,
        recipient_id: row.recipient_id,
        platform_user_id: row.platform_user_id,
        organization_id: row.organization_id,
        client_id: row.client_id,
        telegram_chat_id: String(chat.id),
        telegram_username: chat.username ?? fromUsername ?? null,
        telegram_chat_title: chat.type === 'private' ? null : (chat.title ?? null),
        linked_by: row.created_by,
        linked_at: now,
        is_active: true,
        unlinked_at: null,
      },
      { onConflict: 'recipient_type,recipient_id,telegram_chat_id' },
    )
    .select('id')
    .single()
  if (error) {
    console.error('[telegram] failed to save subscription', error)
    await reply(chat.id, 'Something went wrong connecting this chat. Please try again.')
    return
  }

  await writeAudit({
    actorUserId: row.created_by,
    organizationId: resolved.auditOrganizationId,
    action: 'TELEGRAM_CONNECTED',
    entityType: 'TELEGRAM_SUBSCRIPTION',
    entityId: (sub as { id: string }).id,
    newValues: {
      recipient_type: row.recipient_type,
      recipient_id: row.recipient_id,
      chat_type: chat.type,
      telegram_username: chat.username ?? fromUsername ?? null,
      telegram_chat_title: chat.title ?? null,
    },
  })

  await reply(
    chat.id,
    `✅ Connected — you'll now receive notifications for ${resolved.label} here.`,
  )
}

/** Deactivate every subscription pointing at a chat (bot removed/blocked). */
async function deactivateChat(chatId: number | string) {
  await getSupabaseAdminClient()
    .from('telegram_subscriptions')
    .update({ is_active: false, unlinked_at: new Date().toISOString() })
    .eq('telegram_chat_id', String(chatId))
    .eq('is_active', true)
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const admin = getSupabaseAdminClient()

  // The bot was removed from a group, or a user blocked it.
  const member = update.my_chat_member
  if (member) {
    if (['left', 'kicked'].includes(member.new_chat_member.status)) {
      await deactivateChat(member.chat.id)
    }
    return
  }

  const message = update.message
  if (!message) return

  // A group upgraded to a supergroup: Telegram posts this service message in
  // the old group. Follow the id now, rather than waiting for a failed send.
  if (message.migrate_to_chat_id) {
    await admin
      .from('telegram_subscriptions')
      .update({ telegram_chat_id: String(message.migrate_to_chat_id) })
      .eq('telegram_chat_id', String(message.chat.id))
    return
  }

  const text = message.text?.trim()
  if (!text?.startsWith('/start')) return

  const token = parseStartToken(text)
  if (token) {
    await handleStart(message.chat, message.from?.username, token)
    return
  }
  // Only answer a bare /start in a private chat — in a group, any member
  // typing /start would otherwise get the bot talking.
  if (message.chat.type === 'private') {
    await reply(
      message.chat.id,
      'Hi! To receive Rush Tracker notifications here, open Rush Tracker and choose "Connect Telegram".',
    )
  }
}
