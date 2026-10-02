import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { recordSubscriptionPaymentFn } from '@/server/platform/subscription.fns'
import { formatBdt } from '@/lib/money/money'
import { dhakaToday, nextPeriod } from '@/lib/subscription/plans'
import { PAYMENT_METHODS } from '@/schemas/payment'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const formSchema = z
  .object({
    amount_bdt: z
      .string()
      .trim()
      .refine((v) => v !== '' && !Number.isNaN(Number(v)) && Number(v) > 0, 'Enter an amount above zero'),
    period_start: z.string().min(1, 'Required'),
    period_end: z.string().min(1, 'Required'),
    method: z.string(),
    reference: z.string().max(200),
    note: z.string().max(1000),
  })
  .refine((v) => v.period_end >= v.period_start, {
    message: 'Must be on or after the start',
    path: ['period_end'],
  })
type FormValues = z.infer<typeof formSchema>

export function RecordPaymentDialog({
  open,
  onOpenChange,
  organizationId,
  organizationName,
  planName,
  planFeeBdt,
  paidThrough,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string
  organizationName: string
  planName: string | null
  planFeeBdt: string | null
  paidThrough: string | null
}) {
  const queryClient = useQueryClient()
  const record = useServerFn(recordSubscriptionPaymentFn)
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { amount_bdt: '', period_start: '', period_end: '', method: '', reference: '', note: '' },
  })

  useEffect(() => {
    if (!open) return
    // Prefill one month continuing from the current paid-through date.
    const period = nextPeriod(paidThrough, dhakaToday())
    form.reset({
      amount_bdt: planFeeBdt && Number(planFeeBdt) > 0 ? String(planFeeBdt) : '',
      period_start: period.start,
      period_end: period.end,
      method: '',
      reference: '',
      note: '',
    })
  }, [open, paidThrough, planFeeBdt, form])

  const amount = form.watch('amount_bdt')

  const mutation = useMutation({
    mutationFn: (v: FormValues) =>
      record({
        data: {
          organization_id: organizationId,
          amount_bdt: v.amount_bdt,
          period_start: v.period_start,
          period_end: v.period_end,
          method: v.method || undefined,
          reference: v.reference || undefined,
          note: v.note || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Payment recorded')
      void queryClient.invalidateQueries({ queryKey: ['organization-subscription', organizationId] })
      void queryClient.invalidateQueries({ queryKey: ['organization-billing'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to record payment'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            A payment {organizationName} made to the platform
            {planName ? ` for the ${planName} plan` : ''}. Recorded payments
            can't be edited — record a correction as a new entry.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="subscription-payment-form"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="amount_bdt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount (BDT)</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" {...field} />
                  </FormControl>
                  {amount && !Number.isNaN(Number(amount)) && Number(amount) > 0 && (
                    <p className="num text-xs text-muted-foreground">{formatBdt(amount)}</p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="period_start"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Covers from</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="period_end"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Covers until</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Method (optional)</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Choose" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PAYMENT_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="reference"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reference (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="Transaction id" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="subscription-payment-form" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
