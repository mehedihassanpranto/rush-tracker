import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'

interface ProvisionClientLoginInput {
  email: string
  full_name: string
  password: string
  client_id: string
  /** The organization this login/membership belongs to — the caller's own
   * (an admin provisioning a login, or a client self-adding a teammate).
   * A CLIENT login must stay within one organization: reusing an existing
   * login across organizations would conflate two different subscribing
   * agencies' customers under one identity, so cross-org reuse is refused
   * below rather than silently allowed. */
  organization_id: string
}

interface ProvisionClientLoginResult {
  user_id: string
  reused_existing_user: boolean
}

/**
 * Provisions a CLIENT-role login and links it to one client via
 * client_memberships — reusing an existing auth user by email when one
 * already exists, instead of calling admin.auth.admin.createUser() again
 * (which fails with "A user with this email address has already been
 * registered"). client_memberships.(user_id, client_id) is a composite
 * unique key, not user_id alone, so one auth user legitimately belonging to
 * several clients is already schema-supported — this was the one path that
 * never checked for an existing user before creating.
 *
 * Only reuses an existing account when its role is CLIENT — an email
 * already registered as staff (ADMIN/SUPER_ADMIN) is refused rather than
 * silently linked, since requireClientMembership() would reject that user
 * on login anyway (role !== 'CLIENT'), making a reused membership row
 * useless at best and confusing at worst.
 */
export async function provisionClientLogin(
  input: ProvisionClientLoginInput,
): Promise<ProvisionClientLoginResult> {
  const admin = getSupabaseAdminClient()

  const { data: existingRows, error: lookupErr } = await admin.rpc(
    'find_auth_user_by_email',
    { p_email: input.email },
  )
  if (lookupErr) throw new Error(lookupErr.message)
  const existing = existingRows?.[0] as
    | { user_id: string; role_key: string | null }
    | undefined

  if (existing) {
    if (existing.role_key !== 'CLIENT') {
      throw new Error(
        'This email is already registered under a different account type and cannot be used as a client login.',
      )
    }
    const userId = existing.user_id

    const { data: existingProfile, error: profileLookupErr } = await admin
      .from('user_profiles')
      .select('organization_id')
      .eq('user_id', userId)
      .single()
    if (profileLookupErr) throw new Error(profileLookupErr.message)
    if (existingProfile.organization_id !== input.organization_id) {
      throw new Error(
        'This email is already registered under a different organization and cannot be reused here.',
      )
    }

    const { data: existingMembership, error: memLookupErr } = await admin
      .from('client_memberships')
      .select('id, status')
      .eq('user_id', userId)
      .eq('client_id', input.client_id)
      .maybeSingle()
    if (memLookupErr) throw new Error(memLookupErr.message)

    if (existingMembership) {
      if (existingMembership.status === 'ACTIVE') {
        throw new Error('This email already has an active login for this client.')
      }
      // Reactivate rather than fail on the unique(user_id, client_id)
      // constraint — a previously-removed login being re-added is the
      // common real case here, not a mistake to reject.
      const { error: reactivateErr } = await admin
        .from('client_memberships')
        .update({ status: 'ACTIVE' })
        .eq('id', existingMembership.id)
      if (reactivateErr) throw new Error(reactivateErr.message)
    } else {
      const { error: memErr } = await admin.from('client_memberships').insert({
        user_id: userId,
        client_id: input.client_id,
        status: 'ACTIVE',
        organization_id: input.organization_id,
      })
      if (memErr) throw new Error(memErr.message)
    }

    return { user_id: userId, reused_existing_user: true }
  }

  const { data: created, error } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    app_metadata: { app_role: 'CLIENT' },
    user_metadata: { full_name: input.full_name },
  })
  if (error) throw new Error(error.message)
  const userId = created.user.id

  // The on_auth_user_created trigger creates the profile with organization_id
  // defaulted to org zero (it has no way to know the real target org) —
  // correct it here along with the name.
  await admin
    .from('user_profiles')
    .update({ full_name: input.full_name, organization_id: input.organization_id })
    .eq('user_id', userId)

  const { error: memErr } = await admin.from('client_memberships').insert({
    user_id: userId,
    client_id: input.client_id,
    status: 'ACTIVE',
    organization_id: input.organization_id,
  })
  if (memErr) throw new Error(memErr.message)

  return { user_id: userId, reused_existing_user: false }
}
