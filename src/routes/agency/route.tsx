import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { securityGatePath, isAdminRole } from '@/lib/auth/types'
import { ADMIN_NAV } from '@/components/layout/nav'
import { AppShell } from '@/components/layout/app-shell'

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
    return { user: context.user }
  },
  component: AdminLayout,
})

function AdminLayout() {
  const { user } = Route.useRouteContext()
  const areaLabel = user.organizationName
    ? `Admin · ${user.organizationName}`
    : 'Admin'
  return (
    <AppShell user={user} navItems={ADMIN_NAV} areaLabel={areaLabel}>
      <Outlet />
    </AppShell>
  )
}
