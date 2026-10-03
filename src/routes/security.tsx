import { useState } from 'react'
import { Link, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft, Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
import { toast } from 'sonner'

import {
  changePasswordFn,
  getMfaStatusFn,
  removeMfaFactorFn,
} from '@/server/auth/mfa.fns'
import { changePasswordSchema } from '@/schemas/security'
import { homePathForUser, securityGatePath } from '@/lib/auth/types'
import { MfaEnrollPanel } from '@/components/security/mfa-enroll-panel'
import { StandaloneLayout } from '@/components/security/standalone-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { z } from 'zod'

/** Account security for every kind of account: two-factor sign-in and
 * password. Reached from the user menu. */
export const Route = createFileRoute('/security')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    const gate = securityGatePath(context.user)
    if (gate) throw redirect({ to: gate })
    return { user: context.user }
  },
  component: SecurityPage,
})

function SecurityPage() {
  const { user } = Route.useRouteContext()
  return (
    <StandaloneLayout wide>
      <Link
        to={homePathForUser(user)}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back
      </Link>
      <div className="space-y-6">
        <TwoFactorCard />
        <ChangePasswordCard />
      </div>
    </StandaloneLayout>
  )
}

function TwoFactorCard() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const getStatus = useServerFn(getMfaStatusFn)
  const removeFactor = useServerFn(removeMfaFactorFn)
  const [adding, setAdding] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['mfa-status'], queryFn: () => getStatus() })

  const remove = useMutation({
    mutationFn: (factor_id: string) => removeFactor({ data: { factor_id } }),
    onSuccess: async () => {
      toast.success('Authenticator removed')
      await queryClient.invalidateQueries({ queryKey: ['mfa-status'] })
      await router.invalidate()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Two-factor sign-in
          {data && (
            <Badge
              variant="outline"
              className={
                data.enrolled
                  ? 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'border-transparent bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              }
            >
              {data.enrolled ? 'On' : 'Off'}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          After your password, you'll also enter a code from an authenticator
          app — so a stolen password alone isn't enough to get in.
          {data?.required && ' Required for platform accounts.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-16" />}
        {data?.factors.map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-emerald-600" />
              <span>{f.friendly_name ?? 'Authenticator app'}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={remove.isPending || (data.required && data.factors.length <= 1)}
              onClick={() => remove.mutate(f.id)}
            >
              <ShieldOff className="size-4" />
              Remove
            </Button>
          </div>
        ))}
        {data && (adding || data.factors.length === 0 ? (
          <MfaEnrollPanel
            onDone={async () => {
              toast.success('Two-factor sign-in is on')
              setAdding(false)
              await queryClient.invalidateQueries({ queryKey: ['mfa-status'] })
              await router.invalidate()
            }}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add another authenticator
          </Button>
        ))}
      </CardContent>
    </Card>
  )
}

type PasswordValues = z.input<typeof changePasswordSchema>

function ChangePasswordCard() {
  const changePassword = useServerFn(changePasswordFn)
  const form = useForm<PasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current_password: '', new_password: '' },
  })
  const mutation = useMutation({
    mutationFn: (v: PasswordValues) => changePassword({ data: v }),
    onSuccess: () => {
      toast.success('Password changed')
      form.reset({ current_password: '', new_password: '' })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to change password'),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Password</CardTitle>
        <CardDescription>At least 8 characters.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            method="post"
            onSubmit={form.handleSubmit((v) => mutation.mutate(v))}
            className="space-y-4"
            noValidate
            autoComplete="off"
          >
            <FormField
              control={form.control}
              name="current_password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Current password</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="current-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="new_password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New password</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
              Change password
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}
