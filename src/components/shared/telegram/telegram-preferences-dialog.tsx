import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'

import { setTelegramEventMuteFn } from '@/server/telegram/telegram.fns'
import type { TelegramScope } from '@/lib/telegram/recipients'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'

export interface TelegramPreferenceEventType {
  id: string
  label: string
  enabled: boolean
}

/**
 * Which event types this one connected chat receives. Unchecking one logs
 * `skipped_preference_off` in `notification_events` on the next matching
 * event instead of sending it — the chat itself stays connected either way.
 */
export function TelegramPreferencesDialog({
  open,
  onOpenChange,
  scope,
  subscriptionId,
  chatLabel,
  eventTypes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: TelegramScope
  subscriptionId: string
  chatLabel: string
  eventTypes: Array<TelegramPreferenceEventType>
}) {
  const queryClient = useQueryClient()
  const setMute = useServerFn(setTelegramEventMuteFn)
  const [pending, setPending] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (vars: { event_type: string; enabled: boolean }) =>
      setMute({ data: { scope, subscription_id: subscriptionId, ...vars } }),
    onMutate: (vars) => setPending(vars.event_type),
    onSettled: () => setPending(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['telegram-preferences', scope] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to update preference'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notification preferences</DialogTitle>
          <DialogDescription>
            Choose what {chatLabel} receives. Unchecking an event type keeps the chat
            connected — it just stops sending that one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {eventTypes.length === 0 && (
            <p className="text-sm text-muted-foreground">No event types apply here yet.</p>
          )}
          {eventTypes.map((e) => (
            <div key={e.id} className="flex items-center gap-2">
              <Checkbox
                id={`evt-${e.id}`}
                checked={e.enabled}
                disabled={pending === e.id}
                onCheckedChange={(checked) =>
                  mutation.mutate({ event_type: e.id, enabled: checked === true })
                }
              />
              <Label htmlFor={`evt-${e.id}`} className="text-sm font-normal">
                {e.label}
              </Label>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
