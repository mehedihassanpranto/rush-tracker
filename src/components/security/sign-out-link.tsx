import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { logoutFn } from '@/server/auth/auth.fns'
import { Button } from '@/components/ui/button'

export function SignOutLink() {
  const router = useRouter()
  const logout = useServerFn(logoutFn)
  return (
    <Button
      variant="link"
      className="text-muted-foreground"
      onClick={async () => {
        await logout()
        await router.invalidate()
        await router.navigate({ to: '/login' })
      }}
    >
      Sign out
    </Button>
  )
}
