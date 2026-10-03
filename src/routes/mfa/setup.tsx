import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'

import { homePathForUser, securityGatePath } from '@/lib/auth/types'
import { MfaEnrollPanel } from '@/components/security/mfa-enroll-panel'
import { StandaloneLayout } from '@/components/security/standalone-layout'
import { SignOutLink } from '@/components/security/sign-out-link'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/** Mandatory two-factor setup (platform admins). Optional setup for everyone
 * else lives on /security. */
export const Route = createFileRoute('/mfa/setup')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
    const gate = securityGatePath(context.user)
    if (gate !== '/mfa/setup') throw redirect({ to: gate ?? homePathForUser(context.user) })
    return { user: context.user }
  },
  component: MfaSetupPage,
})

function MfaSetupPage() {
  const router = useRouter()
  const { user } = Route.useRouteContext()
  return (
    <StandaloneLayout wide>
      <Card>
        <CardHeader>
          <CardTitle>Set up two-factor sign-in</CardTitle>
          <CardDescription>
            Platform accounts can see every agency's data, so they must sign in
            with a code from an authenticator app as well as a password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MfaEnrollPanel
            onDone={async () => {
              await router.invalidate()
              await router.navigate({ to: homePathForUser(user) })
            }}
          />
        </CardContent>
      </Card>
      <div className="mt-4 text-center">
        <SignOutLink />
      </div>
    </StandaloneLayout>
  )
}
