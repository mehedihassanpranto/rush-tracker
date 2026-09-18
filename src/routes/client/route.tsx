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
export const Route = createFileRoute('/client')({
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    if (isAdminRole(context.user.role)) {
      throw redirect({ to: '/agency' })
    }
    // A platform-only account holds no agency role, so /agency's role check
    // bounces it here — where it has no client membership and every query
    // would fail. Send it to its own area instead. (Deliberately NOT added to
    // /agency's guard: that would lock a dual-hat account out of its own
    // agency, which is a migration hazard rather than a rule.)
    if (context.user.isPlatformAdmin) {
      throw redirect({ to: '/platform' })
    }
    // Multi-tenant subscription gate (Phase 3) — UX only, redirects here
    // proactively; the real enforcement is server-side in every server fn's
    // guard (guards.server.ts). Platform admins bypass (none exist with
    // role CLIENT today, but the check stays consistent with every other
    // gate in this app).
    if (
      !context.user.isPlatformAdmin &&
      context.user.organizationSubscriptionStatus !== 'active'
    ) {
      throw redirect({ to: '/subscription-suspended' })
    }
    return { user: context.user }
  },
  component: PortalLayout,
})

function PortalLayout() {
  const { user } = Route.useRouteContext()
  const active = activeMemberships(user)

  if (active.length === 0) {
    return <NoMembership />
  }

  // With more than one active membership, name the current one in the
  // header on every portal page — not just the dashboard's switcher —
  // so it's always clear whose data is on screen. The agency name is
  // appended too, since multiple agencies can now serve different clients
  // (multi-tenant) — always clear whose agency this portal belongs to.
  const activeClient = active.find((m) => m.clientId === user.activeClientId)
  const base =
    active.length > 1 && activeClient
      ? `${activeClient.clientName} · Client Portal`
      : 'Client Portal'
  const areaLabel = user.organizationName ? `${base} · ${user.organizationName}` : base

  return (
    <AppShell user={user} navItems={CLIENT_NAV} areaLabel={areaLabel}>
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
