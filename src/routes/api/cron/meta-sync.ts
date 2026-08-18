import { createFileRoute } from '@tanstack/react-router'
import { getServerEnv } from '@/lib/env/env.server'
import { syncMetaAdAccounts } from '@/server/meta/meta-sync.server'
import { retryPendingMetaSpendCapSyncs } from '@/server/meta/spend-cap-sync.server'

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

        // Both jobs run independently — a failure in one (e.g. Meta
        // unreachable) must not block the other (e.g. retrying pending
        // spend_cap syncs, which mostly touches Supabase, not Meta, per row).
        const [syncResult, retryResult] = await Promise.allSettled([
          syncMetaAdAccounts(),
          retryPendingMetaSpendCapSyncs(),
        ])

        if (syncResult.status === 'rejected') {
          console.error('[cron/meta-sync] sync failed', syncResult.reason)
        }
        if (retryResult.status === 'rejected') {
          console.error(
            '[cron/meta-sync] spend cap retry failed',
            retryResult.reason,
          )
        }

        if (
          syncResult.status === 'rejected' &&
          retryResult.status === 'rejected'
        ) {
          return Response.json({ error: 'Meta sync failed' }, { status: 502 })
        }

        return Response.json({
          ok: true,
          sync:
            syncResult.status === 'fulfilled'
              ? syncResult.value
              : { error: 'failed' },
          spend_cap_retry:
            retryResult.status === 'fulfilled'
              ? retryResult.value
              : { error: 'failed' },
        })
      },
    },
  },
})
