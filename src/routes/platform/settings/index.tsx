import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/shared/page-header'
import { IntegrationSettingsCard } from '@/components/shared/integration-settings/integration-settings-card'
import { TelegramConnectCard } from '@/components/shared/telegram/telegram-connect-card'
import { TelegramBotStatusCard } from '@/components/platform/telegram/telegram-bot-status-card'

/**
 * Platform settings — Rush Tracker's own configuration, not any agency's.
 *
 * The Meta credentials here are the ones that reach the portfolio holding the
 * platform-owned ad account pool. They used to live on xRush Agency's own
 * Settings screen, because org zero and "the platform" were the same thing for
 * credential purposes; migration 000037 separated them, and this is where they
 * moved to. Every account in the pool is read and written with these, whichever
 * agency currently holds its grant.
 *
 * No permission check beyond the /platform guard's isPlatformAdmin: the agency
 * side gates this on `integrations.manage` because an agency has admins of
 * varying power, whereas a platform admin is already the most privileged
 * account there is.
 */
export const Route = createFileRoute('/platform/settings/')({
  component: PlatformSettingsPage,
})

function PlatformSettingsPage() {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Rush Tracker's own platform configuration. These credentials serve the platform ad account pool and are never visible to an agency."
      />
      <IntegrationSettingsCard scope="platform" />
      <TelegramConnectCard scope="platform" />
      <TelegramBotStatusCard />
    </div>
  )
}
