import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createOrganizationFn } from '@/server/organizations/organization.fns'
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
import { Textarea } from '@/components/ui/textarea'

const formSchema = z.object({
  name: z.string().trim().min(1, 'Agency name is required'),
  plan: z.string(),
  notes: z.string(),
  admin_full_name: z.string().trim().min(1, "The admin's name is required"),
  admin_email: z.email('Enter a valid email address'),
  admin_password: z.string().min(8, 'Use at least 8 characters'),
})

type FormValues = z.infer<typeof formSchema>

const EMPTY: FormValues = {
  name: '',
  plan: '',
  notes: '',
  admin_full_name: '',
  admin_email: '',
  admin_password: '',
}

export function CreateOrganizationDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const createOrganization = useServerFn(createOrganizationFn)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: EMPTY,
  })

  useEffect(() => {
    if (open) form.reset(EMPTY)
  }, [open, form])

  const mutation = useMutation({
    mutationFn: (values: FormValues) => createOrganization({ data: values }),
    onSuccess: (result) => {
      toast.success(
        `${result.organization.name} created — its admin can sign in now.`,
      )
      void queryClient.invalidateQueries({ queryKey: ['organizations'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to create agency'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New agency</DialogTitle>
          <DialogDescription>
            Creates the organization and its first admin login together. The
            agency starts active, with no clients or ad accounts — its admin
            sets those up themselves.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="create-organization-form"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Agency name</FormLabel>
                  <FormControl>
                    <Input placeholder="Acme Media" {...field} />
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
                      rows={2}
                      placeholder="Payment/renewal info, internal notes..."
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="border-t pt-4">
              <p className="text-sm font-medium">First admin login</p>
              <p className="text-xs text-muted-foreground">
                This person becomes the agency's Super Admin and can add the
                rest of their staff themselves.
              </p>
            </div>

            <FormField
              control={form.control}
              name="admin_full_name"
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
              name="admin_email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="admin_password"
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
            form="create-organization-form"
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Create agency
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
