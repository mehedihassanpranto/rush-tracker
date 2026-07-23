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
    return { user: context.user }
  },
  component: AdminLayout,
})

function AdminLayout() {
  const { user } = Route.useRouteContext()
  return (
    <AppShell user={user} navItems={ADMIN_NAV} areaLabel="Admin">
      <Outlet />
    </AppShell>
  )
}
