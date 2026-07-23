import { createServerFn } from '@tanstack/react-start'
import { getRequestUrl } from '@tanstack/react-start/server'
import { z } from 'zod'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { homePathForUser } from '@/lib/auth/types'
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
    .select('user_id, full_name, status, role_id, role:roles(key)')
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

  return {
    id: user.id,
    email: user.email ?? '',
    fullName: profile.full_name,
    role,
    status: profile.status,
    permissions,
    memberships,
  }
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

    const { error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    })
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

    return { ok: true, redirectTo: homePathForUser(sessionUser) }
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
    const origin = getRequestUrl().origin

    await supabase.auth.resetPasswordForEmail(data.email, {
      redirectTo: `${origin}/reset-password`,
    })

    // Always report success — do not leak whether the email exists.
    return { ok: true as const }
  })
