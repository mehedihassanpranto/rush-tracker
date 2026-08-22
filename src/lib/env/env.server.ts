import { z } from 'zod'

/**
 * Server-side environment validation.
 *
 * The Supabase URL + anon key are public values (also shipped to the browser
 * as VITE_ vars); the service-role key is SERVER ONLY and must never be
 * exposed with a VITE_ prefix or imported from client code.
 */
const serverEnvSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  // Meta Marketing API — optional: unset in environments that haven't
  // connected a Business Portfolio yet (src/server/meta/meta.server.ts
  // throws a clear error at call time if these are missing).
  META_SYSTEM_USER_TOKEN: z.string().min(1).optional(),
  META_BUSINESS_ID: z.string().min(1).optional(),
  META_API_VERSION: z.string().min(1).default('v21.0'),
  // Shared secret for the /api/cron/meta-sync endpoint — Vercel Cron sends
  // it as `Authorization: Bearer <value>` automatically when this env var is
  // set on the project. Optional: unset disables the sync endpoint.
  CRON_SECRET: z.string().min(1).optional(),
  // Telegram Bot API — optional: unset disables Telegram alerts entirely
  // (sendTelegramMessage() no-ops), same "optional integration" pattern as
  // the Meta credentials above.
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

let cached: ServerEnv | undefined

export function getServerEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('getServerEnv() must never be called in the browser')
  }
  if (!cached) {
    const parsed = serverEnvSchema.safeParse({
      SUPABASE_URL:
        process.env.SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL,
      SUPABASE_ANON_KEY:
        process.env.SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      META_SYSTEM_USER_TOKEN: process.env.META_SYSTEM_USER_TOKEN,
      META_BUSINESS_ID: process.env.META_BUSINESS_ID,
      META_API_VERSION: process.env.META_API_VERSION,
      CRON_SECRET: process.env.CRON_SECRET,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    })
    if (!parsed.success) {
      throw new Error(
        `Invalid server environment configuration: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      )
    }
    cached = parsed.data
  }
  return cached
}
