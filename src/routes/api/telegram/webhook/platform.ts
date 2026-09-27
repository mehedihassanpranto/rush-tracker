import { timingSafeEqual } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { getServerEnv } from '@/lib/env/env.server'
import { handleTelegramUpdate } from '@/server/telegram/telegram-link.service'

/**
 * Telegram Bot API webhook for the PLATFORM bot only — a second, separate
 * bot from ../webhook.ts's shared one, so platform-admin chats never share
 * a bot with any agency or client chat. Registered from Platform → Settings
 * → Telegram bot ("Register webhook", platform card) with this exact URL and
 * TELEGRAM_WEBHOOK_SECRET as its secret_token — the SAME secret as the
 * shared bot's webhook is fine to reuse: the two are told apart by which URL
 * Telegram calls, not by the secret, which only proves "this really came
 * from Telegram".
 *
 * Otherwise byte-identical to ../webhook.ts — same auth, same always-200
 * behavior — see that file's comment for why.
 */
function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const Route = createFileRoute('/api/telegram/webhook/platform')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = getServerEnv()
        if (!env.TELEGRAM_PLATFORM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
          return Response.json({ error: 'Telegram not configured' }, { status: 503 })
        }
        if (
          !secretMatches(
            request.headers.get('x-telegram-bot-api-secret-token'),
            env.TELEGRAM_WEBHOOK_SECRET,
          )
        ) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        try {
          const update = await request.json()
          await handleTelegramUpdate(update, 'platform')
        } catch (err) {
          console.error('[telegram/webhook/platform] failed to handle update', err)
        }
        return Response.json({ ok: true })
      },
    },
  },
})
