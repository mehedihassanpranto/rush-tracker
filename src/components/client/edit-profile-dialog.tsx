import { useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { updateMyProfileFn } from '@/server/profile/profile.fns'
import { myProfileUpdateSchema } from '@/schemas/profile'
import type { MyProfileUpdateInput } from '@/schemas/profile'
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

export function EditProfileDialog({
  open,
  onOpenChange,
  currentName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentName: string
}) {
  const router = useRouter()
  const updateProfile = useServerFn(updateMyProfileFn)

  const form = useForm<MyProfileUpdateInput>({
    resolver: zodResolver(myProfileUpdateSchema),
    defaultValues: { full_name: currentName },
  })

  useEffect(() => {
    if (open) form.reset({ full_name: currentName })
  }, [open, currentName, form])

  const mutation = useMutation({
    mutationFn: (values: MyProfileUpdateInput) => updateProfile({ data: values }),
    onSuccess: async () => {
      toast.success('Profile updated')
      onOpenChange(false)
      // The signed-in name lives in root route context (loaded once at
      // beforeLoad), not a query — invalidate the router so the header and
      // this page reflect the new name immediately.
      await router.invalidate()
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>
            Update your display name. Email changes aren't supported here yet.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id="edit-profile-form"
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
          </form>
        </Form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-profile-form"
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
