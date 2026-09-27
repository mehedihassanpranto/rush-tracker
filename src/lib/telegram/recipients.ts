/**
 * Telegram recipient model — isomorphic (no server imports) so the link
 * token/start-payload logic can be unit tested.
 *
 * - platform_admin: broadcast to every ACTIVE platform admin; each admin links
 *   their own chat (recipient_id = their user id).
 * - agency: one organization (recipient_id = organization id).
 * - client: one client (recipient_id = client id).
 */
export type TelegramRecipientType = 'platform_admin' | 'agency' | 'client'

export type TelegramRecipient =
  | { type: 'platform_admin' }
  | { type: 'agency'; organizationId: string }
  | { type: 'client'; clientId: string }

/** Which portal a Connect/Disconnect call comes from. */
export type TelegramScope = 'platform' | 'agency' | 'client'

export const SCOPE_RECIPIENT_TYPE: Record<TelegramScope, TelegramRecipientType> = {
  platform: 'platform_admin',
  agency: 'agency',
  client: 'client',
}

/**
 * Two separate bots, deliberately: `platform` is its own bot that no agency
 * or client chat is ever linked to; `shared` is the one bot agency and
 * client chats both connect to (unrelated to each other on Telegram's side —
 * they just happen to share a bot, the way they always have).
 */
export type TelegramBotKind = 'shared' | 'platform'

export function botKindFor(recipientType: TelegramRecipientType): TelegramBotKind {
  return recipientType === 'platform_admin' ? 'platform' : 'shared'
}

/** The recipient types a given bot's webhook could ever legitimately see —
 * the inverse of `botKindFor`, used to scope a webhook update to only the
 * subscriptions that could actually belong to it. */
export function recipientTypesForBot(kind: TelegramBotKind): Array<TelegramRecipientType> {
  return kind === 'platform' ? ['platform_admin'] : ['agency', 'client']
}

/**
 * Extracts the link token from a message's text. Accepts `/start <token>` in
 * a DM and `/start@BotName <token>` in a group (Telegram appends the bot's
 * username to commands sent in groups). Returns null for anything else,
 * including a bare `/start` with no payload.
 */
export function parseStartToken(text: string | undefined | null): string | null {
  if (!text) return null
  const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{16,64})\s*$/.exec(text.trim())
  return match ? match[1] : null
}

/** A deep link that opens the bot with the token as its /start payload —
 * `startgroup` makes Telegram ask which group to add the bot to. */
export function telegramDeepLink(
  botUsername: string,
  token: string,
  target: 'private' | 'group',
): string {
  const param = target === 'group' ? 'startgroup' : 'start'
  return `https://t.me/${botUsername}?${param}=${token}`
}
