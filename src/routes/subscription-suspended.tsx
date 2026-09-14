import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { ShieldAlert } from 'lucide-react'

import { homePathForUser } from '@/lib/auth/types'
import { logoutFn } from '@/server/auth/auth.fns'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * Multi-tenant subscription conversion, Phase 3: where the admin/portal
 * route guards redirect a signed-in user whose organization's subscription
 * isn't active. No app data is reachable from here — this route calls no
 * data-loading server fn at all, only logoutFn.
 *
 * Not itself gated on "org not active" — a user whose org IS active (or a
 * platform admin) who somehow lands here gets bounced straight back to
 * their normal home instead of seeing a page that doesn't apply to them.
 */
export const Route = createFileRoute('/subscription-suspended')({
  beforeLoad: ({ context }) => {
    if (!context.user) {
      throw redirect({ to: '/login' })
    }
    if (
      context.user.isPlatformAdmin ||
      context.user.organizationSubscriptionStatus === 'active'
    ) {
      throw redirect({ to: homePathForUser(context.user) })
    }
  },
  component: SubscriptionSuspendedPage,
})

function SubscriptionSuspendedPage() {
  const router = useRouter()
  const logout = useServerFn(logoutFn)

  async function onLogout() {
    await logout()
    await router.invalidate()
    await router.navigate({ to: '/login' })
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-destructive/10">
            <ShieldAlert className="size-5 text-destructive" />
          </div>
          <CardTitle>Subscription inactive</CardTitle>
          <CardDescription>
            Your organization's subscription is currently inactive. Contact
            xRush Agency to reactivate access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void onLogout()}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
