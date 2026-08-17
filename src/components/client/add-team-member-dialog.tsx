import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { addTeamMemberFn } from '@/server/team/team.fns'
import { addTeamMemberSchema } from '@/schemas/team'
import type { AddTeamMemberInput } from '@/schemas/team'
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

/** Self-service teammate invite for the signed-in client's own account. */
export function AddTeamMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const addTeamMember = useServerFn(addTeamMemberFn)

  const form = useForm<AddTeamMemberInput>({
    resolver: zodResolver(addTeamMemberSchema),
    defaultValues: { full_name: '', email: '', password: '' },
  })

  useEffect(() => {
    if (open) form.reset({ full_name: '', email: '', password: '' })
  }, [open, form])

  const mutation = useMutation({
    mutationFn: (values: AddTeamMemberInput) => addTeamMember({ data: values }),
    onSuccess: () => {
      toast.success('Teammate added')
      void queryClient.invalidateQueries({ queryKey: ['my-team'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to add teammate'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add team member</DialogTitle>
          <DialogDescription>
            Creates a portal login for someone on your team. Share the
            credentials securely; they can change their password later.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="add-team-member-form"
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
                  <FormDescription>At least 8 characters.</FormDescription>
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
            form="add-team-member-form"
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            Add teammate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
