import { z } from 'zod'

/**
 * Public environment variables (VITE_-prefixed, bundled by Vite). Safe to
 * read from both browser and server code — never put secrets here.
 */
const clientEnvSchema = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(20),
})

let cached: z.infer<typeof clientEnvSchema> | undefined

export function getClientEnv() {
  if (!cached) {
    const parsed = clientEnvSchema.safeParse({
      VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
    })
    if (!parsed.success) {
      throw new Error(
        `Invalid public environment configuration: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      )
    }
    cached = parsed.data
  }
  return cached
}
