import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Pencil } from 'lucide-react'
import { activeMemberships } from '@/lib/auth/types'
import { PageHeader } from '@/components/shared/page-header'
import { StatusBadge } from '@/components/shared/status-badge'
import { EditProfileDialog } from '@/components/client/edit-profile-dialog'
import { TelegramConnectCard } from '@/components/shared/telegram/telegram-connect-card'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export const Route = createFileRoute('/client/profile/')({
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
  const [editOpen, setEditOpen] = useState(false)

  return (
    <div>
      <PageHeader title="Profile" description="Your account details." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Account</CardTitle>
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="size-4" />
                Edit
              </Button>
            </CardAction>
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
        Email changes aren't supported here yet.
      </p>

      {/* Linked to the client currently selected — a login belonging to
          several clients connects each one separately. */}
      <div className="mt-6">
        <TelegramConnectCard scope="client" />
      </div>

      <EditProfileDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        currentName={user.fullName}
      />
    </div>
  )
}
