import { getServerEnv } from '@/lib/env/env.server'

/**
 * Telegram Bot API notifications — best-effort, like notification.service.ts's
 * notify(): fired after the primary write, never throws to the caller, never
 * blocks/rolls back the operation it's attached to. No-ops silently when
 * TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aren't configured, same "optional
 * integration" degrade-gracefully pattern as the Meta integration.
 *
 * Deliberately called only from the specific event sites that want a
 * Telegram alert — not wired into notifyAdmins()/notify() globally, since
 * only a few events (spec: limit request submitted, account disabled,
 * spend cap threshold crossed) should reach Telegram, not every in-app
 * notification.
 */
export async function sendTelegramMessage(text: string): Promise<void> {
  const env = getServerEnv()
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
        }),
      },
    )
    if (!res.ok) {
      const body = await res.text()
      console.error('[telegram] send failed', res.status, body)
    }
  } catch (err) {
    console.error('[telegram] send failed', err)
  }
}
