import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'

import {
  clearIntegrationSettingFn,
  getIntegrationSettingsFn,
} from '@/server/settings/settings.fns'
import {
  clearPlatformIntegrationSettingFn,
  getPlatformIntegrationSettingsFn,
} from '@/server/settings/platform-settings.fns'
import type { IntegrationSettingStatus } from '@/server/settings/settings.fns'
import { EditIntegrationSettingsDialog } from './edit-integration-settings-dialog'
import { SETTINGS_QUERY_KEY } from './scope'
import type { IntegrationScope } from './scope'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

const FIELD_LABELS: Record<IntegrationSettingStatus['field'], string> = {
  meta_system_user_token: 'System User token',
  meta_business_id: 'Business Portfolio ID',
  meta_api_version: 'API version',
}

const SOURCE_LABELS: Record<IntegrationSettingStatus['source'], string> = {
  database: 'Database',
  env: 'Environment variable',
  unset: 'Not set',
}

/**
 * The Meta credentials card, shared by the agency Settings screen and the
 * platform panel. One component on purpose: the two screens show the same
 * three fields with the same masking, clearing and never-prefill rules, and a
 * second copy would drift (see StatCard, and the WIPE_ORDER/reset_all_data
 * drift before it). Only the endpoints and the copy differ.
 */
export function IntegrationSettingsCard({
  scope = 'agency',
}: {
  scope?: IntegrationScope
}) {
  const queryClient = useQueryClient()
  const isPlatform = scope === 'platform'
  // Both hooks always run; the selection picks the endpoint pair. See the
  // dialog for why this is safe.
  const getAgency = useServerFn(getIntegrationSettingsFn)
  const getPlatform = useServerFn(getPlatformIntegrationSettingsFn)
  const clearAgency = useServerFn(clearIntegrationSettingFn)
  const clearPlatform = useServerFn(clearPlatformIntegrationSettingFn)
  const getSettings = isPlatform ? getPlatform : getAgency
  const clearSetting = isPlatform ? clearPlatform : clearAgency
  const queryKey = SETTINGS_QUERY_KEY[scope]
  const [editOpen, setEditOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: [queryKey],
    queryFn: () => getSettings(),
  })

  const settings = data?.fields
  const hasEnvFallback = data?.hasEnvFallback ?? false

  const clearMutation = useMutation({
    mutationFn: (field: IntegrationSettingStatus['field']) =>
      clearSetting({ data: { field } }),
    onSuccess: () => {
      toast.success(
        hasEnvFallback
          ? 'Reverted to the environment variable default'
          : 'Credential removed',
      )
      void queryClient.invalidateQueries({ queryKey: [queryKey] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to clear'),
  })

  return (
    <div className="mb-6 sm:max-w-lg">
      <h2 className="mb-2 text-sm font-semibold">Meta integration</h2>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credentials</CardTitle>
          <CardDescription>
            {isPlatform
              ? "Rush Tracker's own Business Portfolio — the one holding the platform ad account pool. Overrides the META_* environment variables, and takes effect immediately with no redeploy. No agency can read or change these."
              : "Your agency's own Meta Business Portfolio. Nothing is shared with, or inherited from, any other agency on Rush Tracker — including accounts granted to you from the platform pool, which keep using the platform's own credentials."}
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              Edit
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {isLoading && <Skeleton className="h-24 w-full" />}
          {settings && (
            <dl className="divide-y">
              {settings.map((s) => (
                <div key={s.field} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <dt className="text-muted-foreground">{FIELD_LABELS[s.field]}</dt>
                  <dd className="flex items-center gap-2">
                    <span className="font-mono">{s.preview ?? '—'}</span>
                    <Badge variant={s.source === 'unset' ? 'outline' : 'secondary'}>
                      {SOURCE_LABELS[s.source]}
                    </Badge>
                    {s.source === 'database' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto p-0 text-xs text-muted-foreground underline-offset-4 hover:underline"
                        disabled={clearMutation.isPending}
                        onClick={() => clearMutation.mutate(s.field)}
                      >
                        {hasEnvFallback ? 'Clear override' : 'Remove'}
                      </Button>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </CardContent>
      </Card>

      <EditIntegrationSettingsDialog
        scope={scope}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  )
}
