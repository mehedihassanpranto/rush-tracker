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
