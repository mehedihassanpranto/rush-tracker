import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  renameAdAccountFn,
  updateAdAccountFn,
} from '@/server/ad-accounts/ad-account.fns'
import {
  listActiveClientsFn,
  transferAccountFn,
} from '@/server/ad-accounts/assignment.fns'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AdAccount } from '@/types/domain'

const amountField = z
  .string()
  .trim()
  .refine((v) => v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0, {
    message: 'Enter a non-negative amount',
  })

// Optional override: blank/0 means "inherit whichever client currently
// holds this account" (adAccountUsdRate() in rate.service.ts) — only set a
// value here to pin this specific account to its own rate regardless of
// client.
const rateField = z
  .string()
  .trim()
  .refine((v) => v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0), {
    message: 'Enter a non-negative rate',
  })

// ---------------------------------------------------------------------------
// Edit (external id, platform, current limit)
// ---------------------------------------------------------------------------
const editSchema = z.object({
  external_account_id: z.string().trim().optional(),
  platform: z.string().trim().min(1, 'Required'),
  current_limit_usd: amountField,
  usd_rate: rateField,
  threshold_usd: amountField,
})
type EditValues = z.infer<typeof editSchema>

export function AccountEditDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AdAccount
}) {
  const queryClient = useQueryClient()
  const updateAccount = useServerFn(updateAdAccountFn)

  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      external_account_id: account.external_account_id ?? '',
      platform: account.platform,
      current_limit_usd: String(account.current_limit_usd),
      usd_rate: String(account.usd_rate),
      threshold_usd: String(account.threshold_usd),
    },
  })

  useEffect(() => {
    if (open)
      form.reset({
        external_account_id: account.external_account_id ?? '',
        platform: account.platform,
        current_limit_usd: String(account.current_limit_usd),
        usd_rate: String(account.usd_rate),
        threshold_usd: String(account.threshold_usd),
      })
  }, [open, account, form])

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
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['ad-account', account.id] })
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
            Editing the current limit changes the operational USD baseline. It
            does not create billing.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="account-edit-form"
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
                    Clear to 0 to use whichever client currently holds this
                    account's own rate instead of a fixed one.
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
                    Meta's own "pay when balance reaches" auto-charge amount,
                    from its Billing page — not fetchable from Meta, enter it
                    manually.
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
            form="account-edit-form"
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

// ---------------------------------------------------------------------------
// Rename (name only — id/code stay stable, spec §18)
// ---------------------------------------------------------------------------
export function RenameDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AdAccount
}) {
  const queryClient = useQueryClient()
  const renameAccount = useServerFn(renameAdAccountFn)
  const [name, setName] = useState(account.name)

  useEffect(() => {
    if (open) setName(account.name)
  }, [open, account])

  const mutation = useMutation({
    mutationFn: () => renameAccount({ data: { id: account.id, name: name.trim() } }),
    onSuccess: () => {
      toast.success('Account renamed')
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['ad-account', account.id] })
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
        <div className="space-y-2">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Transfer (to another client — spec §16)
// ---------------------------------------------------------------------------
export function TransferDialog({
  open,
  onOpenChange,
  account,
  currentClientId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AdAccount
  currentClientId: string | null
}) {
  const queryClient = useQueryClient()
  const listClients = useServerFn(listActiveClientsFn)
  const transfer = useServerFn(transferAccountFn)
  const [toClientId, setToClientId] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) {
      setToClientId('')
      setNotes('')
    }
  }, [open])

  const { data: clients } = useQuery({
    queryKey: ['active-clients'],
    queryFn: () => listClients(),
    enabled: open,
  })

  const mutation = useMutation({
    mutationFn: () =>
      transfer({
        data: {
          ad_account_id: account.id,
          to_client_id: toClientId,
          notes: notes || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Account transferred')
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['ad-account', account.id] })
      void queryClient.invalidateQueries({ queryKey: ['assignment-history', account.id] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const targets = clients?.filter((c) => c.id !== currentClientId) ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer account</DialogTitle>
          <DialogDescription>
            Closes the current assignment and opens a new one. The carried-over
            limit ({account.current_limit_usd} USD) creates no due for the new
            client.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Transfer to</Label>
            <Select value={toClientId} onValueChange={setToClientId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a client" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.client_code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!toClientId || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
