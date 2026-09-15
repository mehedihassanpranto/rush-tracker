import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createOrganizationAdminFn } from '@/server/organizations/organization.fns'
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

const formSchema = z.object({
  full_name: z.string().trim().min(1, "The admin's name is required"),
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters'),
})

type FormValues = z.infer<typeof formSchema>

const EMPTY: FormValues = { full_name: '', email: '', password: '' }

export function AddOrganizationAdminDialog({
  open,
  onOpenChange,
  organizationId,
  organizationName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string
  organizationName: string
}) {
  const queryClient = useQueryClient()
  const createAdmin = useServerFn(createOrganizationAdminFn)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: EMPTY,
  })

  useEffect(() => {
    if (open) form.reset(EMPTY)
  }, [open, form])

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      createAdmin({ data: { organization_id: organizationId, ...values } }),
    onSuccess: () => {
      toast.success(`Admin added — they can sign in to ${organizationName} now.`)
      void queryClient.invalidateQueries({ queryKey: ['organization', organizationId] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to add admin'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add admin</DialogTitle>
          <DialogDescription>
            Creates a Super Admin login for {organizationName}. They can see and
            manage that agency's own clients, accounts and ledger, and add the
            rest of their staff themselves — so add one only at the agency's
            request. Recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="add-organization-admin-form"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="full_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>
                    Must not already have an account anywhere in Rush Tracker.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Temporary password</FormLabel>
                  <FormControl>
                    <Input type="text" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormDescription>
                    Share this with them — they can change it from the sign-in
                    page's "Forgot password" link.
                  </FormDescription>
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
          <Button
            type="submit"
            form="add-organization-admin-form"
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Add admin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
