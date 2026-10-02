import { createFileRoute } from '@tanstack/react-router'
import { getServerEnv } from '@/lib/env/env.server'
import { syncMetaAdAccounts } from '@/server/meta/meta-sync.server'
import { retryPendingMetaSpendCapSyncs } from '@/server/meta/spend-cap-sync.server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import {
  finishCronRun,
  pruneMonitoringTables,
  recordAppError,
  startCronRun,
} from '@/server/monitoring/monitoring.service'
import {
  alertCronFailure,
  runMetaTokenChecks,
  sendErrorDigest,
} from '@/server/monitoring/health-check.server'

/**
 * Server route (TanStack Start's `server.handlers`, not a page — no
 * `component`) invoked on a schedule — on Hostinger by a cron-panel `curl`
 * (docs/DEPLOYMENT-HOSTINGER.md §5), formerly Vercel Cron (vercel.json); always
 * a GET. There is no signed-in admin for a
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

        // Every run is recorded (cron_runs) so a job that silently stops —
        // e.g. the scheduler wasn't recreated after a hosting move — shows up
        // as "stale" on Platform → System health. `trigger` records who called
        // (host + user agent), which also reveals two schedulers firing.
        const admin = getSupabaseAdminClient()
        const trigger = {
          host: request.headers.get('host'),
          user_agent: request.headers.get('user-agent'),
        }
        const runId = await startCronRun(admin, 'meta-sync', { trigger })

        // The jobs run independently — a failure in one (e.g. Meta
        // unreachable) must not block the others.
        const [syncResult, retryResult, tokenResult] = await Promise.allSettled([
          syncMetaAdAccounts(),
          retryPendingMetaSpendCapSyncs(),
          runMetaTokenChecks(),
        ])

        const failures: Array<string> = []
        const labelled = [
          ['sync', syncResult],
          ['spend cap retry', retryResult],
          ['token check', tokenResult],
        ] as const
        for (const [label, r] of labelled) {
          if (r.status === 'rejected') {
            console.error(`[cron/meta-sync] ${label} failed`, r.reason)
            failures.push(`${label}: ${(r.reason as Error)?.message ?? String(r.reason)}`)
            await recordAppError(admin, {
              source: 'cron',
              error: r.reason,
              fnName: `meta-sync/${label}`,
            })
          }
        }

        // syncMetaAdAccounts() deliberately keeps going when one portfolio
        // fails (one agency's expired token mustn't stop the rest) and reports
        // it in `skipped` instead of throwing — count those as failures too, or
        // a broken portfolio would be logged as a successful run.
        const rejectedJobs = failures.length
        if (syncResult.status === 'fulfilled') {
          for (const s of syncResult.value.skipped) {
            if (s.reason !== 'failed') continue
            failures.push(`sync ${s.organization_name}: ${s.error ?? 'failed'}`)
            await recordAppError(admin, {
              source: 'cron',
              error: new Error(s.error ?? 'Meta sync failed'),
              fnName: `meta-sync/${s.organization_name}`,
              organizationId: s.organization_id,
            })
          }
        }

        // After the jobs, so errors from this very run are included.
        const digest = await sendErrorDigest().catch(() => ({ count: -1 }))
        await pruneMonitoringTables(admin)

        const status =
          failures.length === 0
            ? 'success'
            : rejectedJobs === labelled.length
              ? 'failed'
              : 'partial'
        const summary = {
          trigger,
          sync: syncResult.status === 'fulfilled' ? syncResult.value : { error: 'failed' },
          spend_cap_retry:
            retryResult.status === 'fulfilled' ? retryResult.value : { error: 'failed' },
          tokens: tokenResult.status === 'fulfilled' ? tokenResult.value : { error: 'failed' },
          errors_last_24h: digest.count,
        }
        await finishCronRun(
          admin,
          runId,
          status,
          summary,
          failures.length ? failures.join('\n') : null,
        )
        if (status !== 'success') {
          await alertCronFailure('meta-sync', status, failures.join('\n'))
        }

        if (status === 'failed') {
          return Response.json({ error: 'Meta sync failed', failures }, { status: 502 })
        }
        return Response.json({ ok: true, status, ...summary })
      },
    },
  },
})
