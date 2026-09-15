import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  renamePoolAccountFn,
  updatePoolAccountDetailsFn,
} from '@/server/platform/pool.fns'
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import type { AdAccount } from '@/types/domain'

/**
 * Rename and Edit-details for a POOL account — literal near-duplicates of
 * RenameDialog / AccountEditDialog (components/admin/ad-account/
 * account-dialogs.tsx), calling renamePoolAccountFn / updatePoolAccountDetailsFn
 * instead. Kept separate rather than parameterizing the agency dialogs with a
 * server-fn prop: these two call different query keys to invalidate
 * ('platform-pool-accounts' / 'pool-account' vs 'ad-accounts' / 'ad-account'),
 * and the agency dialogs are shared with Transfer/Assign/Release, which have
 * no platform equivalent at all.
 */

const amountField = z
  .string()
  .trim()
  .refine((v) => v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0, {
    message: 'Enter a non-negative amount',
  })

const rateField = z
  .string()
  .trim()
  .refine((v) => v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0), {
    message: 'Enter a non-negative rate',
  })

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------
export function PoolRenameDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AdAccount
}) {
  const queryClient = useQueryClient()
  const renameAccount = useServerFn(renamePoolAccountFn)
  const [name, setName] = useState(account.name)

  useEffect(() => {
    if (open) setName(account.name)
  }, [open, account])

  const mutation = useMutation({
    mutationFn: () => renameAccount({ data: { id: account.id, name: name.trim() } }),
    onSuccess: () => {
      toast.success('Account renamed')
      void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['pool-account', account.id] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename account</DialogTitle>
          <DialogDescription>
            The account code ({account.account_code}) and all history are
            preserved.
          </DialogDescription>
        </DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Edit details (external id, platform, current limit, per-USD, threshold)
// ---------------------------------------------------------------------------
const editSchema = z.object({
  external_account_id: z.string().trim().optional(),
  platform: z.string().trim().min(1, 'Required'),
  current_limit_usd: amountField,
  usd_rate: rateField,
  threshold_usd: amountField,
})
type EditValues = z.infer<typeof editSchema>

export function PoolEditDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AdAccount
}) {
  const queryClient = useQueryClient()
  const updateAccount = useServerFn(updatePoolAccountDetailsFn)

  const defaults: EditValues = {
    external_account_id: account.external_account_id ?? '',
    platform: account.platform,
    current_limit_usd: String(account.current_limit_usd),
    usd_rate: String(account.usd_rate),
    threshold_usd: String(account.threshold_usd),
  }

  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: defaults,
  })

  useEffect(() => {
    if (open) form.reset(defaults)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account])

  const mutation = useMutation({
    mutationFn: (values: EditValues) =>
      updateAccount({
        data: {
          id: account.id,
          ...values,
          current_limit_usd: Number(values.current_limit_usd),
          usd_rate: Number(values.usd_rate),
          threshold_usd: Number(values.threshold_usd),
        },
      }),
    onSuccess: () => {
      toast.success('Account updated')
      void queryClient.invalidateQueries({ queryKey: ['platform-pool-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['pool-account', account.id] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>
            Editing the current limit changes the pool account's operational
            USD baseline. It does not create billing.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="pool-account-edit-form"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="platform"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Platform</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="external_account_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ad account ID (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="current_limit_usd"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Current limit (USD)</FormLabel>
                  <FormControl>
                    <Input type="number" min="0" step="0.01" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="usd_rate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Per USD (BDT per $1, optional)</FormLabel>
                  <FormControl>
                    <Input type="number" min="0" step="0.01" {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Clear to 0 to inherit whichever client currently holds
                    this account's own rate instead of a fixed one.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="threshold_usd"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Threshold (USD)</FormLabel>
                  <FormControl>
                    <Input type="number" min="0" step="0.01" {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Meta's own "pay when balance reaches" auto-charge amount —
                    not fetchable from Meta, enter it manually.
                  </p>
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
            form="pool-account-edit-form"
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
