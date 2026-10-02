import { cn } from '@/lib/utils'
import { LIMIT_LABELS, planLimit } from '@/lib/subscription/plans'
import type {
  OrganizationUsage,
  PlanLimitKind,
  SubscriptionPlan,
} from '@/lib/subscription/plans'

const KINDS: Array<{ kind: PlanLimitKind; title: string }> = [
  { kind: 'clients', title: 'Active clients' },
  { kind: 'adAccounts', title: 'Ad accounts' },
  { kind: 'staff', title: 'Staff logins' },
]

/**
 * Used vs. allowed for each plan limit. Text always states the numbers; the
 * bar only reinforces them (never colour alone). Amber at 80%+, red at/over
 * the limit — "at the limit" is red because the next add will be refused.
 */
export function UsageMeters({
  plan,
  usage,
}: {
  plan: SubscriptionPlan | null
  usage: OrganizationUsage
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {KINDS.map(({ kind, title }) => {
        const used = usage[kind]
        const limit = planLimit(plan, kind)
        const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, (used / limit) * 100)
        const atLimit = limit !== null && used >= limit
        const near = limit !== null && !atLimit && pct >= 80
        return (
          <div key={kind}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-muted-foreground">{title}</span>
              <span
                className={cn(
                  'num text-sm font-medium',
                  atLimit && 'text-red-600 dark:text-red-400',
                )}
              >
                {used.toLocaleString()} / {limit === null ? 'Unlimited' : limit.toLocaleString()}
              </span>
            </div>
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label={`${title}: ${used} of ${limit ?? 'unlimited'} ${LIMIT_LABELS[kind].many}`}
              aria-valuemin={0}
              aria-valuemax={limit ?? used}
              aria-valuenow={used}
            >
              {limit !== null && (
                <div
                  className={cn(
                    'h-full rounded-full',
                    atLimit ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-primary',
                  )}
                  style={{ width: `${pct}%` }}
                />
              )}
            </div>
            {atLimit && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                At the limit — no more can be added.
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
