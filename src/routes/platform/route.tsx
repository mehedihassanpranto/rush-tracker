import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { homePathForUser } from '@/lib/auth/types'
import { PLATFORM_NAV } from '@/components/layout/nav'
import { AppShell } from '@/components/layout/app-shell'

/**
 * Platform owner's area — the vendor plane, deliberately separate from
 * /agency (one agency's own data) and /client (one client's own data).
 *
 * Unlike /agency this guard checks ONLY isPlatformAdmin, never the
 * ADMIN/SUPER_ADMIN role. While the organizations screen lived under
 * /agency it inherited that route's role check, so a platform admin had to
 * also hold an agency role just to reach it — a future platform-only
 * account would have been bounced to /client and never seen the panel.
 * Splitting the areas removes that coupling.
 *
 * The subscription gate is not applied here either: a platform admin
 * bypasses it everywhere by design (see guards.server.ts), and this is the
 * screen they'd use to fix a subscription in the first place.
 */
export const Route = createFileRoute('/platform')({
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    if (!context.user.isPlatformAdmin) {
      throw redirect({ to: homePathForUser(context.user) })
    }
    return { user: context.user }
  },
  component: PlatformLayout,
})

function PlatformLayout() {
  const { user } = Route.useRouteContext()
  return (
    <AppShell
      user={user}
      navItems={PLATFORM_NAV}
      areaLabel="Platform"
      showSearch={false}
    >
      <Outlet />
    </AppShell>
  )
}
