import { cn } from '@/lib/utils'

/**
 * Wraps a numeric value (spend, balances, percentages, counts) in the
 * monospace/tabular-nums treatment — the app-wide rule that every rendered
 * number reads as "data," distinct from surrounding prose. Prefer this (or
 * a plain className="num") over ad-hoc font classes on money figures.
 */
export function Num({
  children,
  className,
  as: Component = 'span',
}: {
  children: React.ReactNode
  className?: string
  as?: React.ElementType
}) {
  return <Component className={cn('num', className)}>{children}</Component>
}
