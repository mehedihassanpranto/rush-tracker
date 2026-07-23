import { useEffect, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import { Alert, AlertDescription } from '@/components/ui/alert'
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

const formSchema = z
  .object({
    password: z.string().min(8, 'At least 8 characters'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

type FormValues = z.infer<typeof formSchema>

// Standalone route (not under _auth): the recovery link signs the user in
// with a temporary session, and the _auth layout would bounce signed-in
// users away before they could set a new password.
export const Route = createFileRoute('/reset-password')({
  ssr: false,
  component: ResetPasswordPage,
})

type LinkState = 'checking' | 'ready' | 'invalid'

function ResetPasswordPage() {
  const router = useRouter()
  const [linkState, setLinkState] = useState<LinkState>('checking')

  useEffect(() => {
    const supabase = getSupabaseBrowserClient()
    let mounted = true

    // The browser client exchanges the recovery code from the URL for a
    // session automatically; wait for it to land.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted && session) setLinkState('ready')
    })

    void supabase.auth.getSession().then(({ data }) => {
      if (mounted && data.session) setLinkState('ready')
    })

    const timer = setTimeout(() => {
      if (mounted) {
        setLinkState((s) => (s === 'checking' ? 'invalid' : s))
      }
    }, 5000)

    return () => {
      mounted = false
      subscription.unsubscribe()
      clearTimeout(timer)
    }
  }, [])

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  async function onSubmit(values: FormValues) {
    const supabase = getSupabaseBrowserClient()
    const { error } = await supabase.auth.updateUser({
      password: values.password,
    })
    if (error) {
      form.setError('password', { message: error.message })
      return
    }
    toast.success('Password updated. You are signed in.')
    await router.invalidate()
    await router.navigate({ to: '/' })
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 px-4">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Rush Tracker</h1>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set a new password</CardTitle>
          <CardDescription>
            Choose a new password for your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {linkState === 'checking' && (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Verifying reset link…
            </div>
          )}
          {linkState === 'invalid' && (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertDescription>
                  This reset link is invalid or has expired.
                </AlertDescription>
              </Alert>
              <Button asChild variant="outline" className="w-full">
                <Link to="/forgot-password">Request a new link</Link>
              </Button>
            </div>
          )}
          {linkState === 'ready' && (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-4"
                noValidate
              >
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>New password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Confirm password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={form.formState.isSubmitting}
                >
                  {form.formState.isSubmitting && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Update password
                </Button>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
