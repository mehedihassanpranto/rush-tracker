import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { isAdminRole } from '@/lib/auth/types'
import { ADMIN_NAV } from '@/components/layout/nav'
import { AppShell } from '@/components/layout/app-shell'

/**
 * Admin area guard (spec §62): authenticated + ADMIN/SUPER_ADMIN role.
 * UX-level only — every server function re-checks authorization itself.
 */
export const Route = createFileRoute('/admin')({
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    if (!isAdminRole(context.user.role)) {
      throw redirect({ to: '/portal' })
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
  // "Organizations" (platform-admin only) is filtered in here rather than
  // living in ADMIN_NAV unconditionally — everyone else would otherwise
  // see a visible link that 403s.
  const navItems = user.isPlatformAdmin
    ? ADMIN_NAV
    : ADMIN_NAV.filter((item) => !item.platformAdminOnly)
  return (
    <AppShell user={user} navItems={navItems} areaLabel="Admin">
      <Outlet />
    </AppShell>
  )
}
