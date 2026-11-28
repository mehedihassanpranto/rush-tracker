import { Link, Outlet, createFileRoute, redirect, useLocation, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { ShieldAlert, ShieldOff } from 'lucide-react'

import {
  securityGatePath,
  activeMemberships,
  currentMembership,
  isAdminRole,
} from '@/lib/auth/types'
import type { SessionMembership } from '@/lib/auth/types'
import { clientCan, clientPagePermission } from '@/lib/permissions/client-permissions'
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
    // Two-factor step first (UX only — the server guards enforce it too).
    const gate = securityGatePath(context.user)
    if (gate) throw redirect({ to: gate })
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

/** Whether this login's access opens the page (UX only — the page's
 * server fns check the same permission). */
function canOpen(membership: SessionMembership | null, pathname: string): boolean {
  const permission = clientPagePermission(pathname)
  return permission === null || clientCan(membership, permission)
}

function PortalLayout() {
  const { user } = Route.useRouteContext()
  const { pathname } = useLocation()
  const active = activeMemberships(user)
  const membership = currentMembership(user)

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
    <AppShell
      user={user}
      navItems={CLIENT_NAV.filter((i) => !i.to || canOpen(membership, i.to))}
      areaLabel={areaLabel}
    >
      {canOpen(membership, pathname) ? <Outlet /> : <NoAccess />}
    </AppShell>
  )
}

function NoAccess() {
  return (
    <Card className="mx-auto mt-10 max-w-md p-8 text-center">
      <ShieldOff className="mx-auto size-8 text-muted-foreground" />
      <h1 className="mt-3 text-lg font-semibold">You don’t have access to this page</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Ask an owner of your team if you need it.
      </p>
      <Button asChild variant="outline" className="mt-5">
        <Link to="/client">Go to the dashboard</Link>
      </Button>
    </Card>
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
