import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { LogOut, Menu, Search } from 'lucide-react'

import { logoutFn } from '@/server/auth/auth.fns'
import { isAdminRole } from '@/lib/auth/types'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NotificationBell } from './notification-bell'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { SidebarNav } from './sidebar-nav'
import type { NavItem } from './nav'
import type { SessionUser } from '@/lib/auth/types'

function initials(user: SessionUser): string {
  const source = user.fullName.trim() || user.email
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

export function Header({
  user,
  navItems,
  areaLabel,
}: {
  user: SessionUser
  navItems: Array<NavItem>
  areaLabel: string
}) {
  const router = useRouter()
  const logout = useServerFn(logoutFn)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [search, setSearch] = useState('')
  const isAdmin = isAdminRole(user.role)

  async function onLogout() {
    await logout()
    await router.invalidate()
    await router.navigate({ to: '/login' })
  }

  function onSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = search.trim()
    if (q.length < 2) return
    void router.navigate({ to: '/admin/search', search: { q } })
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background px-4 lg:px-6">
      {/* Mobile nav */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden">
            <Menu className="size-5" />
            <span className="sr-only">Open navigation</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="border-b px-4 py-3 text-left">
            <SheetTitle>Rush Tracker</SheetTitle>
          </SheetHeader>
          <div className="py-2">
            <SidebarNav
              items={navItems}
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex items-baseline gap-2">
        <span className="font-semibold">Rush Tracker</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {areaLabel}
        </span>
      </div>

      {isAdmin && (
        <form
          onSubmit={onSearch}
          className="relative ml-4 hidden max-w-xs flex-1 md:block"
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients, accounts, numbers…"
            className="h-9 pl-8"
          />
        </form>
      )}

      <div className="ml-auto flex items-center gap-1">
        <NotificationBell role={user.role} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2 px-2">
              <Avatar className="size-7">
                <AvatarFallback className="text-xs">
                  {initials(user)}
                </AvatarFallback>
              </Avatar>
              <span className="hidden max-w-40 truncate text-sm sm:inline">
                {user.fullName || user.email}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="truncate text-sm font-medium">
                {user.fullName || 'Unnamed user'}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {user.email}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Role: {user.role.replace('_', ' ')}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault()
                void onLogout()
              }}
            >
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
