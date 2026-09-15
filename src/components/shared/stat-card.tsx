import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * The one KPI tile used by the admin dashboard, the client portal dashboard
 * and FinancialSummary — previously three near-identical inline copies that
 * had drifted apart.
 *
 * Two layout rules make a row of these read as one object:
 *  - No empty CardContent. The inline versions rendered `<CardContent />`
 *    with nothing in it, which still cost the card's `gap-6` plus `py-6` —
 *    that was the large dead area under every figure.
 *  - The value is bottom-anchored (`mt-auto`), so every figure in a row sits
 *    on the same baseline even when one card's label wraps to two lines or
 *    carries a hint. Anything explanatory goes above the number, never
 *    between it and the card edge.
 */
export function StatCard({
  label,
  value,
  hint,
  valueClassName,
  loading = false,
}: {
  label: string
  value: React.ReactNode
  /** Short clarifier, sits under the label so it never shifts the figure. */
  hint?: string
  valueClassName?: string
  loading?: boolean
}) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex h-full flex-col p-4">
        <p className="text-sm leading-snug text-muted-foreground">{label}</p>
        {hint && (
          <p className="mt-1 text-xs leading-snug text-muted-foreground/80">
            {hint}
          </p>
        )}
        {/* A div, not a p: `value` may be a Skeleton (which renders a div),
            and a div inside a p is invalid HTML — React hydrates it as a
            sibling and warns. */}
        <div
          className={cn(
            'num mt-auto pt-4 text-2xl font-semibold tracking-tight',
            valueClassName,
          )}
        >
          {loading ? <Skeleton className="h-7 w-24" /> : value}
        </div>
      </div>
    </Card>
  )
}
