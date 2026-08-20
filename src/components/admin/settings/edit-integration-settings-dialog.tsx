import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { updateIntegrationSettingsFn } from '@/server/settings/settings.fns'
import { integrationSettingsUpdateSchema } from '@/schemas/settings'
import type { IntegrationSettingsUpdateInput } from '@/schemas/settings'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'

const EMPTY_VALUES: IntegrationSettingsUpdateInput = {
  meta_system_user_token: '',
  meta_business_id: '',
  meta_api_version: '',
}

/** Every field is optional and starts blank on every open — the real
 * current values (especially the token) are never sent to the browser to
 * prefill this form, so a blank submit is always safe (means "no change"). */
export function EditIntegrationSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const updateSettings = useServerFn(updateIntegrationSettingsFn)

  const form = useForm<IntegrationSettingsUpdateInput>({
    resolver: zodResolver(integrationSettingsUpdateSchema),
    defaultValues: EMPTY_VALUES,
  })

  useEffect(() => {
    if (open) form.reset(EMPTY_VALUES)
  }, [open, form])

  const mutation = useMutation({
    mutationFn: (values: IntegrationSettingsUpdateInput) => {
      // Blank strings mean "unchanged" — strip them before sending so the
      // server's own has-a-value checks stay simple.
      const payload: IntegrationSettingsUpdateInput = {}
      if (values.meta_system_user_token) payload.meta_system_user_token = values.meta_system_user_token
      if (values.meta_business_id) payload.meta_business_id = values.meta_business_id
      if (values.meta_api_version) payload.meta_api_version = values.meta_api_version
      return updateSettings({ data: payload })
    },
    onSuccess: () => {
      toast.success('Integration settings updated')
      void queryClient.invalidateQueries({ queryKey: ['integration-settings'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Meta integration settings</DialogTitle>
          <DialogDescription>
            Leave a field blank to keep its current value. These take effect
            immediately — no redeploy needed.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="edit-integration-settings-form"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            autoComplete="off"
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="meta_system_user_token"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>System User token</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder="Leave blank to keep current value"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    From Business Settings → System Users → Generate Token.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="meta_business_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Business Portfolio ID</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      placeholder="Leave blank to keep current value"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="meta_api_version"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>API version</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="one-time-code"
                      placeholder="e.g. v21.0"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-integration-settings-form"
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
