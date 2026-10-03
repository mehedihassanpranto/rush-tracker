import { useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Loader2 } from 'lucide-react'

import { verifyMfaFn } from '@/server/auth/mfa.fns'
import { homePathForUser, securityGatePath } from '@/lib/auth/types'
import { StandaloneLayout } from '@/components/security/standalone-layout'
import { SignOutLink } from '@/components/security/sign-out-link'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** The two-factor step of signing in. */
export const Route = createFileRoute('/mfa/')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    const gate = securityGatePath(context.user)
    if (gate !== '/mfa') throw redirect({ to: gate ?? homePathForUser(context.user) })
    return { user: context.user }
  },
  component: MfaChallengePage,
})

function MfaChallengePage() {
  const router = useRouter()
  const { user } = Route.useRouteContext()
  const verify = useServerFn(verifyMfaFn)
  const [code, setCode] = useState('')
  const mutation = useMutation({
    mutationFn: () => verify({ data: { code } }),
    onSuccess: async () => {
      await router.invalidate()
      await router.navigate({ to: homePathForUser(user) })
    },
  })

  return (
    <StandaloneLayout>
      <Card>
        <CardHeader>
          <CardTitle>Two-factor sign-in</CardTitle>
          <CardDescription>
            Enter the 6-digit code from your authenticator app for {user.email}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
          >
            {mutation.error && (
              <Alert variant="destructive">
                <AlertDescription>{(mutation.error as Error).message}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1">
              <Label htmlFor="mfa-code">Code</Label>
              <Input
                id="mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
            </div>
            <Button type="submit" className="w-full" disabled={code.length !== 6 || mutation.isPending}>
              {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
              Continue
            </Button>
            <p className="text-xs text-muted-foreground">
              Lost your phone? Ask an administrator to reset your two-factor sign-in.
            </p>
          </form>
        </CardContent>
      </Card>
      <div className="mt-4 text-center">
        <SignOutLink />
      </div>
    </StandaloneLayout>
  )
}
