import { createServerFn } from '@tanstack/react-start'
import {
  getCookies,
  getRequestHeader,
  getRequestIP,
  getRequestUrl,
} from '@tanstack/react-start/server'
import { z } from 'zod'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { clientIpFrom } from '@/lib/auth/rate-limit'
import {
  checkRateLimit,
  rateLimitMessage,
  recordAttempt,
} from '@/server/auth/rate-limit.service'
import {
  securityGatePath,
  ACTIVE_CLIENT_COOKIE,
  activeMemberships,
  homePathForUser,
  resolveActiveClientId,
} from '@/lib/auth/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  RoleKey,
  SessionMembership,
  SessionUser,
  UserStatus,
} from '@/lib/auth/types'

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

const forgotPasswordSchema = z.object({
  email: z.email('Enter a valid email address'),
})

export type LoginInput = z.infer<typeof loginSchema>

export type LoginResult =
  | { ok: true; redirectTo: string }
  | { ok: false; error: string }

// ----------------------------------------------------------------------------
// Session loading
// ----------------------------------------------------------------------------

interface ProfileRow {
  user_id: string
  full_name: string
  status: UserStatus
  role_id: string
  organization_id: string
  is_platform_admin: boolean
  role: { key: RoleKey } | null
}

async function loadSessionUser(
  supabase: SupabaseClient,
): Promise<SessionUser | null> {
  // getUser() validates the JWT against Supabase Auth — never trust
  // getSession() alone on the server.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null

  const { data: profile } = (await supabase
    .from('user_profiles')
    .select(
      'user_id, full_name, status, role_id, organization_id, is_platform_admin, role:roles(key)',
    )
    .eq('user_id', user.id)
    .single()) as { data: ProfileRow | null }

  if (!profile || !profile.role) return null
  if (profile.status !== 'ACTIVE') return null

  const role = profile.role.key

  let permissions: Array<string> = []
  if (role === 'SUPER_ADMIN') {
    const { data } = await supabase.from('permissions').select('key')
    permissions = (data ?? []).map((p: { key: string }) => p.key)
  } else if (role === 'ADMIN') {
    const [{ data: rolePerms }, { data: userPerms }] = await Promise.all([
      supabase
        .from('role_permissions')
        .select('permission:permissions(key)')
        .eq('role_id', profile.role_id),
      supabase
        .from('user_permissions')
        .select('permission:permissions(key)')
        .eq('user_id', user.id),
    ])
    const keys = new Set<string>()
    const rows = [
      ...(rolePerms ?? []),
      ...(userPerms ?? []),
    ] as unknown as Array<{ permission: { key: string } | null }>
    for (const row of rows) {
      if (row.permission) keys.add(row.permission.key)
    }
    permissions = [...keys]
  }

  let memberships: Array<SessionMembership> = []
  if (role === 'CLIENT') {
    const { data } = await supabase
      .from('client_memberships')
      .select(
        'id, status, client:clients(id, client_code, name, status)',
      )
      .eq('user_id', user.id)
    const rows = (data ?? []) as unknown as Array<{
      id: string
      status: SessionMembership['status']
      client: {
        id: string
        client_code: string
        name: string
        status: SessionMembership['clientStatus']
      } | null
    }>
    memberships = rows.flatMap((row) =>
      row.client
        ? [
            {
              membershipId: row.id,
              clientId: row.client.id,
              clientCode: row.client.client_code,
              clientName: row.client.name,
              clientStatus: row.client.status,
              status: row.status,
            },
          ]
        : [],
    )
  }

  const active = activeMemberships({ memberships })
  const cookieClientId = getCookies()[ACTIVE_CLIENT_COOKIE] ?? null
  const activeClientId = resolveActiveClientId(active, cookieClientId)

  // organizations has zero RLS policies for `authenticated` (it can hold
  // cross-tenant subscription data — see the multi-tenant migration), so
  // this one supplementary lookup goes through the service-role client
  // rather than the RLS-scoped `supabase` param used above. Fetched fresh
  // on every session load, never cached — the whole point of the
  // subscription gate is that flipping the toggle takes effect
  // immediately, not on next JWT refresh.
  const admin = getSupabaseAdminClient()
  const { data: org, error: orgError } = await admin
    .from('organizations')
    .select('name, subscription_status')
    .eq('id', profile.organization_id)
    .single()
  if (orgError) {
    // organization_id is a NOT NULL FK, so the row always exists — reaching
    // here means the query itself failed (transient DB/network issue), not
    // a missing organization. Deliberately fails CLOSED (treated as
    // suspended below) rather than granting access on an error, but logged
    // loudly because the visible symptom — every user of that organization
    // bounced to /subscription-suspended — otherwise looks like a
    // subscription problem rather than an outage.
    console.error(
      '[auth] organization subscription lookup failed for org',
      profile.organization_id,
      orgError.message,
    )
  }
  const orgRow = org as
    | { name: string; subscription_status: 'active' | 'suspended' | 'cancelled' }
    | null
  const organizationSubscriptionStatus = orgRow?.subscription_status ?? 'suspended'

  // Two-factor state, from the session itself: currentLevel is what THIS
  // session proved (aal2 = code entered), nextLevel is what the account can
  // reach (aal2 = has a verified authenticator). Local — decodes the JWT and
  // reads the user's factors, no extra network call.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  const mfaEnrolled = aal?.nextLevel === 'aal2'
  const mfaVerified = aal?.currentLevel === 'aal2'
  const organizationName = orgRow?.name ?? ''

  return {
    id: user.id,
    email: user.email ?? '',
    fullName: profile.full_name,
    role,
    status: profile.status,
    permissions,
    memberships,
    activeClientId,
    organizationId: profile.organization_id,
    organizationName,
    isPlatformAdmin: profile.is_platform_admin,
    organizationSubscriptionStatus,
    mfaEnrolled,
    mfaVerified,
  }
}

/** The client's IP: the last X-Forwarded-For hop (added by the hosting proxy
 * — earlier hops can be forged by the client), else the socket address. */
function requestIp(): string | null {
  return clientIpFrom(getRequestHeader('x-forwarded-for'), getRequestIP() ?? null)
}

// ----------------------------------------------------------------------------
// Server functions
// ----------------------------------------------------------------------------

/** Current authenticated user (or null). Called from the root route's
 *  beforeLoad so every route sees the server-validated session. */
export const getCurrentUserFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionUser | null> => {
    const supabase = getSupabaseServerClient()
    return loadSessionUser(supabase)
  },
)

export const loginFn = createServerFn({ method: 'POST' })
  .validator(loginSchema)
  .handler(async ({ data }): Promise<LoginResult> => {
    const supabase = getSupabaseServerClient()
    const admin = getSupabaseAdminClient()
    const ip = requestIp()

    // Checked BEFORE trying the password, so a locked account can't keep
    // being guessed. The message is the same whether or not the email exists.
    const limit = await checkRateLimit(admin, 'login', data.email, ip)
    if (!limit.allowed) {
      return { ok: false, error: rateLimitMessage(limit.retryAfterMinutes) }
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    })
    await recordAttempt(admin, 'login', data.email, ip, !error)
    if (error) {
      return { ok: false, error: 'Invalid email or password.' }
    }

    const sessionUser = await loadSessionUser(supabase)
    if (!sessionUser) {
      await supabase.auth.signOut()
      return {
        ok: false,
        error: 'This account is inactive or not fully provisioned. Contact an administrator.',
      }
    }

    // An account with two-factor sign-in isn't done yet: send it to the code
    // page (and a platform admin without 2FA to set it up).
    return {
      ok: true,
      redirectTo: securityGatePath(sessionUser) ?? homePathForUser(sessionUser),
    }
  })

export const logoutFn = createServerFn({ method: 'POST' }).handler(
  async () => {
    const supabase = getSupabaseServerClient()
    await supabase.auth.signOut()
    return { ok: true as const }
  },
)

export const forgotPasswordFn = createServerFn({ method: 'POST' })
  .validator(forgotPasswordSchema)
  .handler(async ({ data }) => {
    const supabase = getSupabaseServerClient()
    const admin = getSupabaseAdminClient()
    const origin = getRequestUrl().origin
    const ip = requestIp()

    // Reset emails are limited per address and per IP (every request counts,
    // not just failures): stops someone mail-bombing an inbox, and keeps the
    // project inside its email-sending quota. Over the limit, nothing is sent
    // but the response is identical — it must not reveal anything.
    const limit = await checkRateLimit(admin, 'reset', data.email, ip)
    if (limit.allowed) {
      await recordAttempt(admin, 'reset', data.email, ip, true)
      await supabase.auth.resetPasswordForEmail(data.email, {
        redirectTo: `${origin}/reset-password`,
      })
    }

    // Always report success — do not leak whether the email exists.
    return { ok: true as const }
  })
