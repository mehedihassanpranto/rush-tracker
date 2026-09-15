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
  showSearch = true,
  children,
}: {
  user: SessionUser
  navItems: Array<NavItem>
  areaLabel: string
  /** The header's global search covers ONE agency's own clients and
   * accounts, so it's suppressed in the cross-org platform panel where it
   * would search the wrong scope. */
  showSearch?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="min-h-svh bg-background">
      <Header
        user={user}
        navItems={navItems}
        areaLabel={areaLabel}
        showSearch={showSearch}
      />
      <div className="flex">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-60 shrink-0 border-r border-sidebar-border bg-sidebar py-4 lg:block">
          <SidebarNav items={navItems} />
        </aside>
        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  )
}
