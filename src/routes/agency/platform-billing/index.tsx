import { createFileRoute, redirect } from '@tanstack/react-router'

/** Moved into Finance (2026-10-23); kept so old links still land. */
export const Route = createFileRoute('/agency/platform-billing/')({
  beforeLoad: () => {
    throw redirect({ to: '/agency/finance', search: { tab: 'platform' } })
  },
})
