import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'

import { PageHeader } from '@/components/shared/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ResetDataDialog } from '@/components/admin/settings/reset-data-dialog'

export const Route = createFileRoute('/admin/settings/')({
  component: SettingsPage,
})

function SettingsPage() {
  const { user } = Route.useRouteContext()
  const isSuperAdmin = user.role === 'SUPER_ADMIN'
  const [resetOpen, setResetOpen] = useState(false)

  return (
    <div>
      <PageHeader
        title="Settings"
        description="System configuration. The USD rate is now set per client, on each client's profile."
      />

      {isSuperAdmin && (
        <div className="sm:max-w-lg">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-destructive">
            <TriangleAlert className="size-4" />
            Danger zone
          </h2>
          <Card className="border-destructive/40">
            <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
              <div className="flex-1">
                <div className="font-medium">Clear all data</div>
                <div className="text-sm text-muted-foreground">
                  Permanently delete all clients, ad accounts, financial records
                  and client logins. Admin logins are kept. Cannot be undone.
                </div>
              </div>
              <Button
                variant="destructive"
                onClick={() => setResetOpen(true)}
                className="shrink-0"
              >
                Clear all data
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      <ResetDataDialog open={resetOpen} onOpenChange={setResetOpen} />
    </div>
  )
}
