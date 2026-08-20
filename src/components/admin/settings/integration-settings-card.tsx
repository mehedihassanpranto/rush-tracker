import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'

import {
  clearIntegrationSettingFn,
  getIntegrationSettingsFn,
} from '@/server/settings/settings.fns'
import type { IntegrationSettingStatus } from '@/server/settings/settings.fns'
import { EditIntegrationSettingsDialog } from './edit-integration-settings-dialog'
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

export function IntegrationSettingsCard() {
  const queryClient = useQueryClient()
  const getSettings = useServerFn(getIntegrationSettingsFn)
  const clearSetting = useServerFn(clearIntegrationSettingFn)
  const [editOpen, setEditOpen] = useState(false)

  const { data: settings, isLoading } = useQuery({
    queryKey: ['integration-settings'],
    queryFn: () => getSettings(),
  })

  const clearMutation = useMutation({
    mutationFn: (field: IntegrationSettingStatus['field']) =>
      clearSetting({ data: { field } }),
    onSuccess: () => {
      toast.success('Reverted to the environment variable default')
      void queryClient.invalidateQueries({ queryKey: ['integration-settings'] })
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
            Overrides the META_* environment variables — takes effect
            immediately, no redeploy needed.
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
                        Clear override
                      </Button>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </CardContent>
      </Card>

      <EditIntegrationSettingsDialog open={editOpen} onOpenChange={setEditOpen} />
    </div>
  )
}
