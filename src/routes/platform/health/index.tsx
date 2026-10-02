import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { checkTokensNowFn, getSystemHealthFn } from '@/server/platform/health.fns'
import type { SystemHealth } from '@/server/platform/health.fns'
import { CRON_STALE_HOURS } from '@/lib/monitoring/health'
import type { TokenState } from '@/lib/monitoring/health'
import { PageHeader } from '@/components/shared/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

/**
 * Platform → System health: is the daily job running, are the Meta tokens
 * alive, and what has the server been throwing. Guarded by the /platform
 * layout; the real boundary is requirePlatformAdmin() on the fns.
 */
export const Route = createFileRoute('/platform/health/')({
  component: HealthPage,
})

const GOOD = 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
const WARN = 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300'
const BAD = 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
const MUTED = 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <Badge variant="outline" className={cn('border-transparent', tone)}>
      {children}
    </Badge>
  )
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`
  if (h < 48) return `${Math.round(h)} h ago`
  return `${Math.round(h / 24)} days ago`
}

const TOKEN_PILL: Record<TokenState, { tone: string; label: string }> = {
  ok: { tone: GOOD, label: 'Working' },
  expiring: { tone: WARN, label: 'Expires soon' },
  invalid: { tone: BAD, label: 'Not working' },
  unknown: { tone: MUTED, label: "Couldn't check" },
  not_configured: { tone: MUTED, label: 'Not connected' },
}

function HealthPage() {
  const queryClient = useQueryClient()
  const getHealth = useServerFn(getSystemHealthFn)
  const checkTokens = useServerFn(checkTokensNowFn)
  const { data, isLoading, error } = useQuery({
    queryKey: ['system-health'],
    queryFn: () => getHealth(),
  })
  const check = useMutation({
    mutationFn: () => checkTokens(),
    onSuccess: (r) => {
      toast.success(`Checked ${r.checked} token${r.checked === 1 ? '' : 's'}`)
      void queryClient.invalidateQueries({ queryKey: ['system-health'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Check failed'),
  })

  return (
    <div>
      <PageHeader
        title="System health"
        description="The daily background job, Meta token status, and recent server errors. Problems are also sent to platform admins in-app and on Telegram."
      />
      {isLoading && <Skeleton className="h-64 w-full" />}
      {error && (
        <p className="text-sm text-destructive">
          Couldn't load: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      )}
      {data && (
        <div className="space-y-6">
          <CronCard cron={data.cron} />

          <Card className="p-0">
            <CardHeader className="px-6 pt-6">
              <CardTitle className="text-base">Meta tokens</CardTitle>
              <CardAction>
                <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
                  {check.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  Check now
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Portfolio</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="pr-6">Last checked</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.tokens.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                        Not checked yet — press Check now, or wait for the next daily run.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.tokens.map((t) => (
                    <TableRow key={t.scope_key}>
                      <TableCell className="pl-6 font-medium">{t.label}</TableCell>
                      <TableCell>
                        <Pill tone={TOKEN_PILL[t.state].tone}>{TOKEN_PILL[t.state].label}</Pill>
                        {t.error && t.state !== 'ok' && (
                          <div className="mt-1 max-w-md text-xs text-muted-foreground">{t.error}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t.expires_at || t.data_access_expires_at
                          ? fmt(t.expires_at ?? t.data_access_expires_at)
                          : t.state === 'ok'
                            ? 'Never'
                            : '—'}
                      </TableCell>
                      <TableCell className="pr-6 text-muted-foreground">{ago(t.checked_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="p-0">
            <CardHeader className="px-6 pt-6">
              <CardTitle className="text-base">
                Server errors{' '}
                <span className="num font-normal text-muted-foreground">
                  — {data.errors.last_24h} in 24 h, {data.errors.last_7d} in 7 days
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Error</TableHead>
                    <TableHead>Where</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                    <TableHead className="pr-6">Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.errors.groups.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                        No server errors in the last 7 days.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.errors.groups.map((g) => (
                    <TableRow key={`${g.fn_name}|${g.message}`}>
                      <TableCell className="max-w-md pl-6 whitespace-normal break-words">{g.message}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{g.fn_name ?? '—'}</TableCell>
                      <TableCell className="num text-right">{g.count}</TableCell>
                      <TableCell className="pr-6 text-muted-foreground">{ago(g.last_seen)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

function CronCard({ cron }: { cron: SystemHealth['cron'] }) {
  const last = cron.last_run
  const hosts = [...new Set(cron.recent.map((r) => r.host).filter(Boolean))]
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Daily Meta sync</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {cron.freshness !== 'ok' && (
          <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {cron.freshness === 'never'
              ? 'No successful run has been recorded yet.'
              : `No successful run in over ${CRON_STALE_HOURS} hours.`}{' '}
            Check that the hosting cron calls <code>/api/cron/meta-sync</code> daily with the
            CRON_SECRET header (docs/DEPLOYMENT-HOSTINGER.md §5). Without it, Meta names,
            disabled-account and low-balance alerts, spend-cap retries and these health
            checks all stop.
          </p>
        )}
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted-foreground">Status</dt>
            <dd className="mt-1">
              {cron.freshness === 'ok' ? (
                <Pill tone={GOOD}>Running</Pill>
              ) : (
                <Pill tone={BAD}>{cron.freshness === 'never' ? 'Never ran' : 'Stale'}</Pill>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Last success</dt>
            <dd className="mt-1 font-medium">
              {fmt(cron.last_success_at)}{' '}
              <span className="text-sm font-normal text-muted-foreground">({ago(cron.last_success_at)})</span>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Last run</dt>
            <dd className="mt-1">
              {last ? (
                <>
                  <Pill tone={last.status === 'success' ? GOOD : last.status === 'running' ? MUTED : BAD}>
                    {last.status}
                  </Pill>{' '}
                  <span className="text-sm text-muted-foreground">{ago(last.started_at)}</span>
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>
        {last?.error && (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{last.error}</pre>
        )}
        {hosts.length > 1 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Recent runs were triggered from more than one host ({hosts.join(', ')}) — two
            schedulers may be calling this job.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
