import { timingSafeEqual } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { getServerEnv } from '@/lib/env/env.server'
import { handleTelegramUpdate } from '@/server/telegram/telegram-link.service'

/**
 * Telegram Bot API webhook — registered from the platform panel's Settings
 * ("Register webhook"), which calls setWebhook with this URL and
 * TELEGRAM_WEBHOOK_SECRET as its secret_token.
 *
 * Telegram sends that secret back as X-Telegram-Bot-Api-Secret-Token on
 * every call; it is the only thing standing between this endpoint and anyone
 * who can POST a forged "/start <token>" update, so it is compared in
 * constant time and required (503 when unset rather than accepting unsigned
 * updates).
 *
 * Always answers 200 once authenticated, even if handling failed: a non-2xx
 * makes Telegram retry the same update indefinitely and stall every update
 * queued behind it.
 */
function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const Route = createFileRoute('/api/telegram/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = getServerEnv()
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
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
          await handleTelegramUpdate(update)
        } catch (err) {
          console.error('[telegram/webhook] failed to handle update', err)
        }
        return Response.json({ ok: true })
      },
    },
  },
})
