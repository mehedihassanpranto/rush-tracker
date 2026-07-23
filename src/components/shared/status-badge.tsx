import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Spec §73: consistent badges, always readable text (never color alone).
const STATUS_STYLES: Record<string, string> = {
  ACTIVE: 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  AVAILABLE: 'border-transparent bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  INACTIVE: 'border-transparent bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  SUSPENDED: 'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  RELEASED: 'border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  PENDING: 'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  APPROVED: 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  REJECTED: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  CANCELLED: 'border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  // Ledger entry / adjustment types
  LIMIT_APPROVAL: 'border-transparent bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  PAYMENT: 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  ADJUSTMENT_DEBIT: 'border-transparent bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  ADJUSTMENT_CREDIT: 'border-transparent bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
  ADD_DUE: 'border-transparent bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  REDUCE_DUE: 'border-transparent bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
  REVERSAL: 'border-transparent bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
}

function label(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function StatusBadge({
  status,
  className,
}: {
  status: string
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn(STATUS_STYLES[status] ?? '', className)}
    >
      {label(status)}
    </Badge>
  )
}
