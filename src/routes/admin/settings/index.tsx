import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronRight, Coins, TriangleAlert } from 'lucide-react'

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
      <PageHeader title="Settings" description="System configuration." />

      <div className="grid gap-3 sm:max-w-lg">
        <Link to="/admin/settings/exchange-rate">
          <Card className="transition-colors hover:bg-accent/50">
            <CardContent className="flex items-center gap-3 py-4">
              <div className="flex size-9 items-center justify-center rounded-md bg-muted">
                <Coins className="size-5" />
              </div>
              <div className="flex-1">
                <div className="font-medium">Exchange rate</div>
                <div className="text-sm text-muted-foreground">
                  Manage the default USD→BDT rate used for billing.
                </div>
              </div>
              <ChevronRight className="size-4 text-muted-foreground" />
            </CardContent>
          </Card>
        </Link>
      </div>

      {isSuperAdmin && (
        <div className="mt-10 sm:max-w-lg">
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
