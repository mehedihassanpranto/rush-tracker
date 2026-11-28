import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { createClientUserFn } from '@/server/clients/client.fns'
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
import {
  NEW_MEMBER_ACCESS,
  PortalAccessFields,
} from '@/components/shared/portal-access'
import type { PortalAccess } from '@/components/shared/portal-access'

const formSchema = z.object({
  full_name: z.string().trim().min(1, 'Name is required'),
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})

type FormValues = z.infer<typeof formSchema>

/** Provision a client login and link it to this client (spec §12, §57). */
export function AddLoginDialog({
  open,
  onOpenChange,
  clientId,
  firstLogin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  /** No active Owner yet → this login starts as the Owner. */
  firstLogin: boolean
}) {
  const queryClient = useQueryClient()
  const createClientUser = useServerFn(createClientUserFn)
  const [access, setAccess] = useState<PortalAccess>(NEW_MEMBER_ACCESS)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { full_name: '', email: '', password: '' },
  })

  useEffect(() => {
    if (!open) return
    form.reset({ full_name: '', email: '', password: '' })
    setAccess(firstLogin ? { is_owner: true, permissions: [] } : NEW_MEMBER_ACCESS)
  }, [open, form, firstLogin])

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      createClientUser({ data: { client_id: clientId, ...values, ...access } }),
    onSuccess: (result) => {
      toast.success(
        result.reused_existing_user
          ? 'Existing login linked to this client'
          : 'Client login created',
      )
      void queryClient.invalidateQueries({ queryKey: ['client-users', clientId] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to create login'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add client login</DialogTitle>
          <DialogDescription>
            Creates a portal login linked to this client. Share the credentials
            securely; the user can reset their password later.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="add-login-form"
            method="post"
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
                    <Input type="text" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>
                    At least 8 characters. Ignored if this email is already a
                    login for another client — it will be linked here
                    instead, keeping its existing password.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <PortalAccessFields value={access} onChange={setAccess} idPrefix="add-login" />
          </form>
        </Form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-login-form"
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Create login
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
