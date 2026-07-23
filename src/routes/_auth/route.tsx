import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { homePathForUser } from '@/lib/auth/types'

export const Route = createFileRoute('/_auth')({
  beforeLoad: ({ context }) => {
    if (context.user) {
      throw redirect({ to: homePathForUser(context.user) })
    }
  },
  component: AuthLayout,
})

function AuthLayout() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 px-4">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Rush Tracker</h1>
        <p className="text-sm text-muted-foreground">
          Ad account limit, billing &amp; payment management
        </p>
      </div>
      <div className="w-full max-w-sm">
        <Outlet />
      </div>
    </div>
  )
}
