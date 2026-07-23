import { createFileRoute } from '@tanstack/react-router'
import { activeMemberships } from '@/lib/auth/types'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const Route = createFileRoute('/portal/profile/')({
  component: ProfilePage,
})

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2">{value || '—'}</dd>
    </div>
  )
}

function ProfilePage() {
  const { user } = Route.useRouteContext()
  const memberships = activeMemberships(user)

  return (
    <div>
      <PageHeader title="Profile" description="Your account details." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Account</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <InfoRow label="Name" value={user.fullName} />
              <InfoRow label="Email" value={user.email} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Client access</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              {memberships.map((m) => (
                <InfoRow
                  key={m.clientId}
                  label={m.clientCode}
                  value={
                    <span className="flex items-center gap-2">
                      {m.clientName}
                      <StatusBadge status={m.status} />
                    </span>
                  }
                />
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Editing profile details will be enabled in a later phase.
      </p>
    </div>
  )
}
