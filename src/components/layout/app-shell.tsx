import { Header } from './header'
import { SidebarNav } from './sidebar-nav'
import type { NavItem } from './nav'
import type { SessionUser } from '@/lib/auth/types'

/**
 * Shared dashboard shell: sticky header, fixed desktop sidebar, mobile sheet
 * navigation. Admin UI is desktop-first; the client portal stays fully
 * responsive (spec §3.3).
 */
export function AppShell({
  user,
  navItems,
  areaLabel,
  children,
}: {
  user: SessionUser
  navItems: Array<NavItem>
  areaLabel: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-svh bg-muted/30">
      <Header user={user} navItems={navItems} areaLabel={areaLabel} />
      <div className="flex">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-60 shrink-0 border-r bg-background py-4 lg:block">
          <SidebarNav items={navItems} />
        </aside>
        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  )
}
