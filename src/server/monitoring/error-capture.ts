import { createMiddleware } from '@tanstack/react-start'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { recordAppError } from '@/server/monitoring/monitoring.service'
import { isExpectedError } from '@/lib/monitoring/health'

/**
 * Global server-function middleware (registered in src/start.ts): records any
 * unexpected error a server fn throws into app_errors, then rethrows it
 * unchanged — the caller sees exactly what it saw before. Expected errors
 * (auth, plan limits, validation, router redirects) are skipped so the log
 * stays about real problems.
 *
 * Only the `.server()` callback touches server-only code; TanStack Start
 * compiles that callback out of the client bundle, the same way it does a
 * createServerFn handler.
 */
export const errorCaptureMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next, serverFnMeta }) => {
    try {
      return await next()
    } catch (err) {
      if (!isExpectedError(err)) {
        await recordAppError(getSupabaseAdminClient(), {
          source: 'server_fn',
          error: err,
          fnName: serverFnMeta?.name ?? null,
          fnFile: serverFnMeta?.filename ?? null,
        })
      }
      throw err
    }
  },
)
