import { createServerFn } from '@tanstack/react-start'
import { setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'
import { requireClientMembership } from './guards.server'
import { ACTIVE_CLIENT_COOKIE } from '@/lib/auth/types'

/**
 * Switches which of the caller's client memberships the portal treats as
 * "current" — every portal server fn resolves its client scope through
 * requireClientMembership()'s cookie fallback, so this one write is enough
 * to redirect the whole portal's data. Re-validates the target client
 * server-side via requireClientMembership(data.client_id) — never trusts
 * that the requested id is actually one of the caller's own memberships.
 */
export const setActiveClientFn = createServerFn({ method: 'POST' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { membership } = await requireClientMembership(data.client_id)
    setCookie(ACTIVE_CLIENT_COOKIE, membership.clientId, {
      path: '/',
      maxAge: 60 * 60 * 24 * 180,
      sameSite: 'lax',
    })
    return { ok: true }
  })
