import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { upsertPlanFn } from '@/server/platform/subscription.fns'
import type { PlanWithUsage } from '@/server/platform/subscription.fns'
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'

const limit = z
  .string()
  .trim()
  .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) <= 1_000_000), 'Whole number, or blank for unlimited')

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  monthly_fee_bdt: z
    .string()
    .trim()
    .refine((v) => v !== '' && !Number.isNaN(Number(v)) && Number(v) >= 0, 'Enter 0 or more'),
  max_clients: limit,
  max_ad_accounts: limit,
  max_staff: limit,
  sort_order: z.string().trim().refine((v) => /^\d+$/.test(v), 'Whole number'),
  is_active: z.boolean(),
})
type FormValues = z.infer<typeof formSchema>

const blank = (n: number | null) => (n === null ? '' : String(n))

export function PlanDialog({
  open,
  onOpenChange,
  plan,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create a new plan */
  plan: PlanWithUsage | null
}) {
  const queryClient = useQueryClient()
  const upsertPlan = useServerFn(upsertPlanFn)
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      monthly_fee_bdt: '',
      max_clients: '',
      max_ad_accounts: '',
      max_staff: '',
      sort_order: '0',
      is_active: true,
    },
  })

  useEffect(() => {
    if (!open) return
    form.reset(
      plan
        ? {
            name: plan.name,
            monthly_fee_bdt: String(plan.monthly_fee_bdt),
            max_clients: blank(plan.max_clients),
            max_ad_accounts: blank(plan.max_ad_accounts),
            max_staff: blank(plan.max_staff),
            sort_order: String(plan.sort_order),
            is_active: plan.is_active,
          }
        : {
            name: '',
            monthly_fee_bdt: '',
            max_clients: '',
            max_ad_accounts: '',
            max_staff: '',
            sort_order: '0',
            is_active: true,
          },
    )
  }, [open, plan, form])

  const mutation = useMutation({
    mutationFn: (v: FormValues) =>
      upsertPlan({
        data: {
          ...(plan ? { id: plan.id } : {}),
          name: v.name,
          monthly_fee_bdt: v.monthly_fee_bdt,
          max_clients: v.max_clients,
          max_ad_accounts: v.max_ad_accounts,
          max_staff: v.max_staff,
          sort_order: v.sort_order,
          is_active: v.is_active,
        },
      }),
    onSuccess: () => {
      toast.success(plan ? 'Plan updated' : 'Plan created')
      void queryClient.invalidateQueries({ queryKey: ['subscription-plans'] })
      void queryClient.invalidateQueries({ queryKey: ['organization-subscription'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save plan'),
  })

  const limitField = (name: 'max_clients' | 'max_ad_accounts' | 'max_staff', label: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input inputMode="numeric" placeholder="Unlimited" {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{plan ? `Edit ${plan.name}` : 'New plan'}</DialogTitle>
          <DialogDescription>
            Leave a limit blank for unlimited. Lowering a limit never removes
            anything from an agency — it only stops new additions past it.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="plan-form"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
            noValidate
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Standard" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="monthly_fee_bdt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly fee (BDT)</FormLabel>
                    <FormControl>
                      <Input inputMode="decimal" placeholder="4000" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {limitField('max_clients', 'Active clients')}
              {limitField('max_ad_accounts', 'Ad accounts')}
              {limitField('max_staff', 'Staff logins')}
            </div>
            <div className="grid items-end gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="sort_order"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display order</FormLabel>
                    <FormControl>
                      <Input inputMode="numeric" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="is_active"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start gap-2 pb-2">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={(c) => field.onChange(c === true)} />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Available</FormLabel>
                      <FormDescription>Offered when assigning a plan</FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </div>
          </form>
        </Form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="plan-form" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            {plan ? 'Save changes' : 'Create plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
