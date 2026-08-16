import { createFileRoute } from '@tanstack/react-router'
import { getServerEnv } from '@/lib/env/env.server'
import { syncMetaAdAccounts } from '@/server/meta/meta-sync.server'

/**
 * Server route (TanStack Start's `server.handlers`, not a page — no
 * `component`) invoked on a schedule by Vercel Cron (see vercel.json's
 * `crons` entry, which always issues GET). There is no signed-in admin for a
 * cron-triggered request, so this can't go through requireAdmin() like the
 * rest of the app's server fns. Authorization here is a shared secret
 * instead: Vercel automatically sends `Authorization: Bearer <CRON_SECRET>`
 * when that env var is set on the project.
 */
export const Route = createFileRoute('/api/cron/meta-sync')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const env = getServerEnv()
        if (!env.CRON_SECRET) {
          return Response.json(
            { error: 'CRON_SECRET not configured' },
            { status: 503 },
          )
        }
        const auth = request.headers.get('authorization')
        if (auth !== `Bearer ${env.CRON_SECRET}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        try {
          const result = await syncMetaAdAccounts()
          return Response.json({ ok: true, ...result })
        } catch (err) {
          console.error('[cron/meta-sync] failed', err)
          return Response.json(
            { error: err instanceof Error ? err.message : 'Meta sync failed' },
            { status: 502 },
          )
        }
      },
    },
  },
})
