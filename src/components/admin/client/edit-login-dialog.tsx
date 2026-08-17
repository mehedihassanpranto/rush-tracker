import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { updateClientUserProfileFn } from '@/server/clients/client.fns'
import { clientUserUpdateSchema } from '@/schemas/client'
import type { ClientUserUpdateInput } from '@/schemas/client'
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
import type { ClientUserRow } from '@/server/clients/client.fns'

export function EditLoginDialog({
  open,
  onOpenChange,
  clientId,
  login,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  login: ClientUserRow | null
}) {
  const queryClient = useQueryClient()
  const updateProfile = useServerFn(updateClientUserProfileFn)

  const form = useForm<ClientUserUpdateInput>({
    resolver: zodResolver(clientUserUpdateSchema),
    defaultValues: { user_id: '', client_id: clientId, full_name: '', email: '' },
  })

  useEffect(() => {
    if (open && login) {
      form.reset({
        user_id: login.user_id,
        client_id: clientId,
        full_name: login.full_name,
        email: login.email,
      })
    }
  }, [open, login, clientId, form])

  const mutation = useMutation({
    mutationFn: (values: ClientUserUpdateInput) => updateProfile({ data: values }),
    onSuccess: () => {
      toast.success('Login updated')
      void queryClient.invalidateQueries({ queryKey: ['client-users', clientId] })
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit login</DialogTitle>
          <DialogDescription>
            Updates this person's name and email. Password resets aren't
            supported here yet.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="edit-login-form"
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
          </form>
        </Form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-login-form"
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
