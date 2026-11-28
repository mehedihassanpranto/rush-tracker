import { Link, Outlet, createFileRoute, redirect, useLocation } from '@tanstack/react-router'
import { ShieldOff } from 'lucide-react'
import { hasPermission, securityGatePath, isAdminRole } from '@/lib/auth/types'
import type { SessionUser } from '@/lib/auth/types'
import { agencyPagePermission } from '@/lib/permissions/agency-roles'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { ADMIN_NAV } from '@/components/layout/nav'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/** Whether the user's role opens this agency page (UX only — each page's
 * server fns check the same permission). */
function canOpen(user: SessionUser, pathname: string): boolean {
  const permission = agencyPagePermission(pathname)
  return permission === null || hasPermission(user, permission)
}

function navFor(user: SessionUser) {
  return ADMIN_NAV.filter(
    (i) =>
      (!i.superAdminOnly || user.role === 'SUPER_ADMIN') &&
      (!i.to || canOpen(user, i.to)),
  )
}

/**
 * Admin area guard (spec §62): authenticated + ADMIN/SUPER_ADMIN role.
 * UX-level only — every server function re-checks authorization itself.
 */
export const Route = createFileRoute('/agency')({
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    // Two-factor step first (UX only — the server guards enforce it too).
    const gate = securityGatePath(context.user)
    if (gate) throw redirect({ to: gate })
    if (!isAdminRole(context.user.role)) {
      throw redirect({ to: '/client' })
    }
    // Multi-tenant subscription gate (Phase 3) — UX only, redirects here
    // proactively; the real enforcement is server-side in every server
    // fn's guard (guards.server.ts). Platform admins bypass entirely.
    if (
      !context.user.isPlatformAdmin &&
      context.user.organizationSubscriptionStatus !== 'active'
    ) {
      throw redirect({ to: '/subscription-suspended' })
    }
    // A role without the dashboard lands on the first page it can open
    // (Settings is open to every admin).
    const path = location.pathname.replace(/\/+$/, '')
    if (path === '/agency' && !canOpen(context.user, path)) {
      const first = navFor(context.user).find((i) => i.to && i.to !== '/agency')
      throw redirect({ to: first?.to ?? '/agency/settings' })
    }
    return { user: context.user }
  },
  component: AdminLayout,
})

function AdminLayout() {
  const { user } = Route.useRouteContext()
  const { pathname } = useLocation()
  const areaLabel = user.organizationName
    ? `Admin · ${user.organizationName}`
    : 'Admin'
  return (
    <AppShell
      user={user}
      navItems={navFor(user)}
      areaLabel={areaLabel}
      showSearch={hasPermission(user, PERMISSIONS.DASHBOARD_VIEW)}
    >
      {canOpen(user, pathname) ? <Outlet /> : <NoAccess />}
    </AppShell>
  )
}

function NoAccess() {
  return (
    <Card className="mx-auto mt-10 max-w-md p-8 text-center">
      <ShieldOff className="mx-auto size-8 text-muted-foreground" />
      <h1 className="mt-3 text-lg font-semibold">You don’t have access to this page</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your role doesn’t include it. Ask a Super Admin if you need it.
      </p>
      <Button asChild variant="outline" className="mt-5">
        <Link to="/agency">Go to your start page</Link>
      </Button>
    </Card>
  )
}
