import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import type { NavItem } from './nav'

export function SidebarNav({
  items,
  onNavigate,
}: {
  items: Array<NavItem>
  onNavigate?: () => void
}) {
  return (
    <nav className="grid gap-1 px-2">
      {items.map((item) =>
        item.to ? (
          <Link
            key={item.label}
            to={item.to}
            onClick={onNavigate}
            activeOptions={{ exact: true }}
            activeProps={{
              className: 'bg-accent text-accent-foreground',
            }}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
              'text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        ) : (
          <span
            key={item.label}
            title={`Coming in Phase ${item.phase}`}
            aria-disabled="true"
            className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground/50"
          >
            <item.icon className="size-4 shrink-0" />
            {item.label}
            <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              P{item.phase}
            </span>
          </span>
        ),
      )}
    </nav>
  )
}
