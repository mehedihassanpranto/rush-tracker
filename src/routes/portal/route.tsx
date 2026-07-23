import { Outlet, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { ShieldAlert } from 'lucide-react'

import { activeMemberships, isAdminRole } from '@/lib/auth/types'
import { logoutFn } from '@/server/auth/auth.fns'
import { CLIENT_NAV } from '@/components/layout/nav'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * Client portal guard (spec §62): authenticated + CLIENT role. An active
 * client membership is additionally required to see any data; users without
 * one get a friendly lock-out screen instead of a redirect loop.
 */
export const Route = createFileRoute('/portal')({
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    if (isAdminRole(context.user.role)) {
      throw redirect({ to: '/admin' })
    }
    return { user: context.user }
  },
  component: PortalLayout,
})

function PortalLayout() {
  const { user } = Route.useRouteContext()

  if (activeMemberships(user).length === 0) {
    return <NoMembership />
  }

  return (
    <AppShell user={user} navItems={CLIENT_NAV} areaLabel="Client Portal">
      <Outlet />
    </AppShell>
  )
}

function NoMembership() {
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
          <CardTitle>No active client access</CardTitle>
          <CardDescription>
            Your account is not currently linked to an active client
            organization. Contact your agency administrator to restore access.
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
