import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronRight, Coins } from 'lucide-react'

import { PageHeader } from '@/components/shared/page-header'
import { Card, CardContent } from '@/components/ui/card'

export const Route = createFileRoute('/admin/settings/')({
  component: SettingsPage,
})

function SettingsPage() {
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
    </div>
  )
}
