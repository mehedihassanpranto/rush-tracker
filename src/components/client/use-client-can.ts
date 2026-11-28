import { useRouteContext } from '@tanstack/react-router'
import { currentMembership } from '@/lib/auth/types'
import { clientCan } from '@/lib/permissions/client-permissions'
import type { ClientPermission } from '@/lib/permissions/client-permissions'

/** Whether the signed-in login may do this in the client it's viewing
 * (000069). UX only — the server fn checks the same permission. */
export function useClientCan(permission: ClientPermission): boolean {
  const { user } = useRouteContext({ from: '/client' })
  return clientCan(currentMembership(user), permission)
}
