import { Link } from '@tanstack/react-router'
import type { LinkProps } from '@tanstack/react-router'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function SectionCard({
  title,
  viewAll,
  children,
}: {
  title: string
  viewAll?: LinkProps
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {viewAll && (
          <Link
            {...viewAll}
            className="text-xs text-primary underline-offset-4 hover:underline"
          >
            View all
          </Link>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="py-6 text-center text-sm text-muted-foreground">{text}</div>
  )
}

export function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

const ACTION_LABELS: Record<string, string> = {
  CLIENT_CREATED: 'Client created',
  CLIENT_UPDATED: 'Client updated',
  CLIENT_STATUS_CHANGED: 'Client status changed',
  CLIENT_DELETED: 'Client deleted',
  CLIENT_USER_CREATED: 'Client login created',
  AD_ACCOUNT_CREATED: 'Ad account created',
  AD_ACCOUNT_UPDATED: 'Ad account updated',
  AD_ACCOUNT_RENAMED: 'Ad account renamed',
  AD_ACCOUNT_STATUS_CHANGED: 'Ad account status changed',
  ACCOUNT_ASSIGNED: 'Account assigned',
  ACCOUNT_RELEASED: 'Account released',
  ACCOUNT_TRANSFERRED: 'Account transferred',
  LIMIT_REQUEST_CREATED: 'Limit requested',
  LIMIT_REQUEST_APPROVED: 'Limit approved',
  LIMIT_REQUEST_REJECTED: 'Limit rejected',
  LIMIT_REQUEST_REBASED: 'Limit request rebased',
  LIMIT_REQUEST_CANCELLED: 'Limit request cancelled',
  PAYMENT_SUBMITTED: 'Payment submitted',
  PAYMENT_APPROVED: 'Payment approved',
  PAYMENT_REJECTED: 'Payment rejected',
  PAYMENT_CANCELLED: 'Payment cancelled',
  PAYMENT_REQUEST_CREATED: 'Payment requested',
  PAYMENT_REQUEST_CANCELLED: 'Payment request cancelled',
  ADJUSTMENT_CREATED: 'Adjustment created',
  REVERSAL_CREATED: 'Transaction reversed',
  DEFAULT_RATE_CHANGED: 'Default rate changed',
  USER_CREATED: 'Admin user created',
  ROLE_CHANGED: 'Role changed',
  USER_STATUS_CHANGED: 'User status changed',
  PERMISSION_CHANGED: 'Permissions changed',
}

export function actionLabel(action: string): string {
  return (
    ACTION_LABELS[action] ??
    action
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}
