import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { addTeamMemberFn } from '@/server/team/team.fns'
import { addTeamMemberSchema } from '@/schemas/team'
import {
  NEW_MEMBER_ACCESS,
  PortalAccessFields,
} from '@/components/shared/portal-access'
import type { PortalAccess } from '@/components/shared/portal-access'
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
  canMakeOwner,
  grantable,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Only an Owner adds Owners (teamAddRefusal()). */
  canMakeOwner: boolean
  /** A Member gives only what it has; undefined for an Owner. */
  grantable?: ReadonlyArray<string>
}) {
  const queryClient = useQueryClient()
  const addTeamMember = useServerFn(addTeamMemberFn)

  const [access, setAccess] = useState<PortalAccess>(NEW_MEMBER_ACCESS)
  const form = useForm<Omit<AddTeamMemberInput, 'is_owner' | 'permissions'>>({
    resolver: zodResolver(addTeamMemberSchema.omit({ is_owner: true, permissions: true })),
    defaultValues: { full_name: '', email: '', password: '' },
  })

  useEffect(() => {
    if (!open) return
    form.reset({ full_name: '', email: '', password: '' })
    // A Member who manages the team starts others with what it can give.
    setAccess({
      is_owner: false,
      permissions: NEW_MEMBER_ACCESS.permissions.filter((p) => !grantable || grantable.includes(p)),
    })
  }, [open, form, grantable])

  const mutation = useMutation({
    mutationFn: (values: Omit<AddTeamMemberInput, 'is_owner' | 'permissions'>) =>
      addTeamMember({ data: { ...values, ...access } }),
    onSuccess: (result) => {
      toast.success(
        result.reused_existing_user
          ? 'Existing login linked to your team'
          : 'Teammate added',
      )
      void queryClient.invalidateQueries({ queryKey: ['my-team'] })
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to add teammate'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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
                    At least 8 characters. Ignored if this email already has
                    a login elsewhere — it will be linked to your team
                    instead, keeping its existing password.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <PortalAccessFields
              value={access}
              onChange={setAccess}
              canMakeOwner={canMakeOwner}
              grantable={grantable}
              idPrefix="add-member"
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
