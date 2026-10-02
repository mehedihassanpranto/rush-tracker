import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { BillingStatus } from '@/lib/subscription/plans'

const STYLES: Record<BillingStatus, { label: string; className: string }> = {
  paid: {
    label: 'Paid',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  overdue: {
    label: 'Overdue',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
  unpaid: {
    label: 'No payment yet',
    className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  },
  exempt: {
    label: 'Billing exempt',
    className: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
  no_plan: {
    label: 'No paid plan',
    className: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  },
}

export function BillingBadge({ status }: { status: BillingStatus }) {
  const s = STYLES[status]
  return (
    <Badge variant="outline" className={cn('border-transparent', s.className)}>
      {s.label}
    </Badge>
  )
}
