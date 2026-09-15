import { createFileRoute, redirect } from '@tanstack/react-router'

/** Organizations is the platform panel's only screen today, so /platform
 * lands straight on it. Give this a real overview page once there's more
 * than one thing to show. */
export const Route = createFileRoute('/platform/')({
  beforeLoad: () => {
    throw redirect({ to: '/platform/organizations' })
  },
  component: () => null,
})
