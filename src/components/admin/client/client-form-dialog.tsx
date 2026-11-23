import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createClientFn, updateClientFn } from '@/server/clients/client.fns'
import { accountsOffRate } from '@/lib/money/usd-rate'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import type { AdAccount, Client } from '@/types/domain'

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  company_name: z.string().trim().optional(),
  email: z.union([z.literal(''), z.email('Enter a valid email')]),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  usd_rate: z
    .string()
    .trim()
    .min(1, 'Enter the USD rate')
    .refine((v) => Number(v) > 0, 'Must be greater than zero'),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
  segment: z.enum(['prepaid', 'partial', 'postpaid']),
})

type FormValues = z.infer<typeof formSchema>

export function ClientFormDialog({
  open,
  onOpenChange,
  client,
  accounts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  client?: Client
  /** The client's active ad accounts — editing the rate offers to set it on
   * them too, since an account's own rate wins over the client's. */
  accounts?: ReadonlyArray<Pick<AdAccount, 'id' | 'account_code' | 'usd_rate'>>
}) {
  const isEdit = Boolean(client)
  const queryClient = useQueryClient()
  const createClient = useServerFn(createClientFn)
  const updateClient = useServerFn(updateClientFn)
  const [applyToAccounts, setApplyToAccounts] = useState(true)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      company_name: '',
      email: '',
      phone: '',
      address: '',
      usd_rate: '',
      status: 'ACTIVE',
      segment: 'postpaid',
    },
  })

  useEffect(() => {
    if (open) {
      form.reset({
        name: client?.name ?? '',
        company_name: client?.company_name ?? '',
        email: client?.email ?? '',
        phone: client?.phone ?? '',
        address: client?.address ?? '',
        usd_rate: client ? String(client.usd_rate) : '',
        status: client?.status ?? 'ACTIVE',
        segment: client?.segment ?? 'postpaid',
      })
      setApplyToAccounts(true)
    }
  }, [open, client, form])

  const rate = form.watch('usd_rate')
  const offRate = isEdit ? accountsOffRate(accounts ?? [], rate) : []
  const offRates = [...new Set(offRate.map((a) => Number(a.usd_rate)))]
    .sort((x, y) => x - y)
    .map((r) => `৳${r}`)

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      if (isEdit && client) {
        return updateClient({
          data: {
            id: client.id,
            ...values,
            apply_rate_to_accounts: applyToAccounts && offRate.length > 0,
          },
        })
      }
      return createClient({ data: values })
    },
    onSuccess: (saved) => {
      const updatedAccounts =
        (saved as { accounts_rate_updated?: number }).accounts_rate_updated ?? 0
      toast.success(
        !isEdit
          ? `Client created (${saved.client_code})`
          : updatedAccounts > 0
            ? `Client updated · rate set on ${updatedAccounts} ad account${updatedAccounts === 1 ? '' : 's'}`
            : 'Client updated',
      )
      void queryClient.invalidateQueries({ queryKey: ['clients'] })
      void queryClient.invalidateQueries({ queryKey: ['client', saved.id] })
      if (updatedAccounts > 0) {
        void queryClient.invalidateQueries({ queryKey: ['client-accounts', saved.id] })
        void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] })
        void queryClient.invalidateQueries({ queryKey: ['ad-account'] })
      }
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit client' : 'New client'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update this client organization.'
              : 'A client code is assigned automatically.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="client-form"
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
                    <Input placeholder="Client 01" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="company_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email (optional)</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone (optional)</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address (optional)</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
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
                  <FormLabel>USD rate (BDT per $1)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min="0"
                      step="0.0001"
                      placeholder="130"
                      {...field}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    The rate charged per US dollar for this client. Used to bill
                    approved limits and to show due in USD.
                  </p>
                  <FormMessage />
                  {offRate.length > 0 && (
                    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
                      <Checkbox
                        id="apply-rate-to-accounts"
                        checked={applyToAccounts}
                        onCheckedChange={(v) => setApplyToAccounts(v === true)}
                        className="mt-0.5"
                      />
                      <div className="space-y-1">
                        <Label
                          htmlFor="apply-rate-to-accounts"
                          className="text-sm leading-snug font-normal"
                        >
                          Also use ৳{Number(rate)} on {offRate.length} ad account
                          {offRate.length === 1 ? '' : 's'} (now {offRates.join(', ')})
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Each account bills at its own rate. Unticked, new
                          requests on them keep the old rate. Past requests never
                          change.
                        </p>
                      </div>
                    </div>
                  )}
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
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="INACTIVE">Inactive</SelectItem>
                      <SelectItem value="SUSPENDED">Suspended</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="segment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Client segment</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a segment" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="prepaid">
                        Prepaid (Full Amount)
                      </SelectItem>
                      <SelectItem value="partial">
                        Partial (Pay Some Now)
                      </SelectItem>
                      <SelectItem value="postpaid">
                        Postpaid (Due System)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Prepaid clients must pay the full amount (with proof) to
                    submit a request. Partial clients pay some amount now
                    (editable, with proof) and owe the rest. Postpaid clients
                    request first and settle the due later.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" form="client-form" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {isEdit ? 'Save changes' : 'Create client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
