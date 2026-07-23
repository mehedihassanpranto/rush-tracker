import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  createAdAccountFn,
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

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  external_account_id: z.string().trim().optional(),
  platform: z.string().trim().min(1, 'Required'),
  current_limit_usd: amountField,
  status: z.enum(['AVAILABLE', 'INACTIVE', 'SUSPENDED']),
})
type CreateValues = z.infer<typeof createSchema>

export function AccountCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const createAccount = useServerFn(createAdAccountFn)

  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      external_account_id: '',
      platform: 'META',
      current_limit_usd: '0',
      status: 'AVAILABLE',
    },
  })

  useEffect(() => {
    if (open)
      form.reset({
        name: '',
        external_account_id: '',
        platform: 'META',
        current_limit_usd: '0',
        status: 'AVAILABLE',
      })
  }, [open, form])

  const mutation = useMutation({
    mutationFn: (values: CreateValues) =>
      createAccount({
        data: { ...values, current_limit_usd: Number(values.current_limit_usd) },
      }),
    onSuccess: (acc) => {
      toast.success(`Account created (${acc.account_code})`)
      void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ad account</DialogTitle>
          <DialogDescription>
            An account code is assigned automatically. A newly created account
            is unassigned.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="account-create-form"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="XR Meta Account 01" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
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
                    <FormLabel>External ID (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="123456789" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
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
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="AVAILABLE">Available</SelectItem>
                        <SelectItem value="INACTIVE">Inactive</SelectItem>
                        <SelectItem value="SUSPENDED">Suspended</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </form>
        </Form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="account-create-form"
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Create account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Edit (external id, platform, current limit)
// ---------------------------------------------------------------------------
const editSchema = z.object({
  external_account_id: z.string().trim().optional(),
  platform: z.string().trim().min(1, 'Required'),
  current_limit_usd: amountField,
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
      current_limit_usd: account.current_limit_usd,
    },
  })

  useEffect(() => {
    if (open)
      form.reset({
        external_account_id: account.external_account_id ?? '',
        platform: account.platform,
        current_limit_usd: account.current_limit_usd,
      })
  }, [open, account, form])

  const mutation = useMutation({
    mutationFn: (values: EditValues) =>
      updateAccount({
        data: {
          id: account.id,
          ...values,
          current_limit_usd: Number(values.current_limit_usd),
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
                  <FormLabel>External ID (optional)</FormLabel>
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
