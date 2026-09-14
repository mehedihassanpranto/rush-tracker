import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { updateOrganizationFn } from '@/server/organizations/organization.fns'
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
import { Textarea } from '@/components/ui/textarea'
import type { Organization } from '@/types/domain'

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  plan: z.string(),
  notes: z.string(),
})

type FormValues = z.infer<typeof formSchema>

export function EditOrganizationDialog({
  open,
  onOpenChange,
  organization,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  organization: Organization | null
}) {
  const queryClient = useQueryClient()
  const updateOrganization = useServerFn(updateOrganizationFn)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', plan: '', notes: '' },
  })

  useEffect(() => {
    if (open) {
      form.reset({
        name: organization?.name ?? '',
        plan: organization?.plan ?? '',
        notes: organization?.notes ?? '',
      })
    }
  }, [open, organization, form])

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      if (!organization) throw new Error('No organization selected')
      return updateOrganization({ data: { id: organization.id, ...values } })
    },
    onSuccess: () => {
      toast.success('Organization updated')
      void queryClient.invalidateQueries({ queryKey: ['organizations'] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit organization</DialogTitle>
          <DialogDescription>
            Name, plan, and renewal/payment notes — activate or suspend from the
            row action instead.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="organization-form"
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
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="plan"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Plan (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Standard, Pro" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={4}
                      placeholder="Payment/renewal info, internal notes..."
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
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="organization-form" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
