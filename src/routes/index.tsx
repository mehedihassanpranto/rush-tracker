import { createFileRoute, redirect } from '@tanstack/react-router'
import { homePathForUser } from '@/lib/auth/types'

export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    if (!context.user) {
      throw redirect({ to: '/login' })
    }
    throw redirect({ to: homePathForUser(context.user) })
  },
  component: () => null,
})
