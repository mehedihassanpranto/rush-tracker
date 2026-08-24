import { cn } from '@/lib/utils'

/**
 * Budget/payment health for the "status rail" — the 3px colored left
 * border used on ad-account, client, and invoice/payment rows and cards.
 * `null` means "unknown" (no data to judge health from yet, e.g. Meta
 * unreachable or account unlinked) and renders no color.
 */
export type RailHealth = 'on-track' | 'near-cap' | 'over-cap'

const RAIL_CLASS: Record<RailHealth, string> = {
  'on-track': 'status-rail-on-track',
  'near-cap': 'status-rail-near-cap',
  'over-cap': 'status-rail-over-cap',
}

/** className fragment for applying the rail directly to a table row. */
export function railClassName(health: RailHealth | null): string {
  return cn('status-rail', health ? RAIL_CLASS[health] : 'border-l-transparent')
}

/** Card-shaped equivalent, for non-table rail usage. */
export function StatusRail({
  health,
  className,
  children,
}: {
  health: RailHealth | null
  className?: string
  children: React.ReactNode
}) {
  return <div className={cn(railClassName(health), className)}>{children}</div>
}
