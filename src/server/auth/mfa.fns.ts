import { createServerFn } from '@tanstack/react-start'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import {
  AuthError,
  requirePlatformAdmin,
  requireSignedIn,
  requireUser,
} from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import {
  checkRateLimit,
  rateLimitMessage,
  recordAttempt,
} from '@/server/auth/rate-limit.service'
import { assertCurrentPassword, requestIp } from '@/server/auth/password-check.service'
import {
  MFA_REQUIRED_FOR_PLATFORM_ADMINS,
  hasPermission,
  isAdminRole,
} from '@/lib/auth/types'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  changePasswordSchema,
  mfaConfirmEnrollSchema,
  mfaRemoveSchema,
  mfaResetSchema,
  mfaVerifySchema,
} from '@/schemas/security'
import { UserError } from '@/lib/errors/user-error'

/**
 * Two-factor sign-in (TOTP authenticator apps) and password changes.
 *
 * Built on Supabase Auth MFA: a session that has entered a code is "aal2".
 * The setup/verify fns use requireSignedIn() on purpose — they are how a
 * half-signed-in user BECOMES fully signed in, so they can't demand that
 * already. Everything else in the app goes through a guard that does.
 *
 * Code checks are rate-limited per account (auth_attempts), because Supabase
 * only limits per IP and every request here comes from the server's IP.
 */

export interface MfaStatus {
  enrolled: boolean
  verified: boolean
  required: boolean
  factors: Array<{ id: string; friendly_name: string | null; created_at: string }>
}

export const getMfaStatusFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MfaStatus> => {
    const user = await requireSignedIn()
    const supabase = getSupabaseServerClient()
    const { data, error } = await supabase.auth.mfa.listFactors()
    if (error) throw new Error(error.message)
    return {
      enrolled: user.mfaEnrolled,
      verified: user.mfaVerified,
      required: MFA_REQUIRED_FOR_PLATFORM_ADMINS && user.isPlatformAdmin,
      factors: (data?.totp ?? []).map((f) => ({
        id: f.id,
        friendly_name: f.friendly_name ?? null,
        created_at: f.created_at,
      })),
    }
  },
)

/**
 * Start setting up an authenticator: returns the QR code and the secret to
 * type in by hand. Leftover unfinished setups are removed first (each
 * abandoned attempt would otherwise count against the account's factor
 * limit). Adding a second authenticator requires an already-verified session.
 */
export const startMfaEnrollFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ factor_id: string; qr_code: string; secret: string }> => {
    const user = await requireSignedIn()
    if (user.mfaEnrolled && !user.mfaVerified) {
      throw new AuthError('MFA_REQUIRED', 'Enter your current two-factor code first')
    }
    const supabase = getSupabaseServerClient()
    const { data: existing } = await supabase.auth.mfa.listFactors()
    for (const f of existing?.all ?? []) {
      if (f.factor_type === 'totp' && f.status === 'unverified') {
        await supabase.auth.mfa.unenroll({ factorId: f.id })
      }
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      issuer: 'Rush Tracker',
      friendlyName: `Authenticator ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    })
    if (error || !data) throw new Error(error?.message ?? 'Could not start two-factor setup')
    return { factor_id: data.id, qr_code: data.totp.qr_code, secret: data.totp.secret }
  },
)

async function verifyCode(
  userId: string,
  factorId: string,
  code: string,
): Promise<void> {
  const admin = getSupabaseAdminClient()
  const ip = requestIp()
  const limit = await checkRateLimit(admin, 'mfa', userId, ip)
  if (!limit.allowed) throw new UserError(rateLimitMessage(limit.retryAfterMinutes))
  const supabase = getSupabaseServerClient()
  // On success the server client writes the upgraded (aal2) session cookies.
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
  await recordAttempt(admin, 'mfa', userId, ip, !error)
  if (error) throw new UserError('That code is not correct. Check your authenticator app and try again.')
}

/** Finish setup: the first correct code both verifies the authenticator and
 * upgrades this session. */
export const confirmMfaEnrollFn = createServerFn({ method: 'POST' })
  .validator(mfaConfirmEnrollSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const user = await requireSignedIn()
    await verifyCode(user.id, data.factor_id, data.code)
    await writeAudit({
      actorUserId: user.id,
      organizationId: user.organizationId,
      action: 'MFA_ENABLED',
      entityType: 'USER',
      entityId: user.id,
    })
    return { ok: true }
  })

/** The sign-in step: check this session's code against the account's
 * verified authenticator. */
export const verifyMfaFn = createServerFn({ method: 'POST' })
  .validator(mfaVerifySchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const user = await requireSignedIn()
    const supabase = getSupabaseServerClient()
    const { data: factors, error } = await supabase.auth.mfa.listFactors()
    if (error) throw new Error(error.message)
    const factor = factors?.totp?.[0]
    if (!factor) throw new Error('This account has no authenticator set up.')
    await verifyCode(user.id, factor.id, data.code)
    return { ok: true }
  })

/** Turn off one authenticator. Requires a fully signed-in session, and a
 * platform admin can't remove their last one (2FA is mandatory for them). */
export const removeMfaFactorFn = createServerFn({ method: 'POST' })
  .validator(mfaRemoveSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const user = await requireUser()
    const supabase = getSupabaseServerClient()
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const verified = factors?.totp ?? []
    if (!verified.some((f) => f.id === data.factor_id)) throw new Error('Authenticator not found')
    if (MFA_REQUIRED_FOR_PLATFORM_ADMINS && user.isPlatformAdmin && verified.length <= 1) {
      throw new UserError('Two-factor sign-in is required for platform admins. Add another authenticator before removing this one.')
    }
    const { error } = await supabase.auth.mfa.unenroll({ factorId: data.factor_id })
    if (error) throw new Error(error.message)
    await writeAudit({
      actorUserId: user.id,
      organizationId: user.organizationId,
      action: 'MFA_DISABLED',
      entityType: 'USER',
      entityId: user.id,
    })
    return { ok: true }
  })

/**
 * Remove ALL of another user's authenticators — the recovery path for a lost
 * phone. Who may do it:
 * - a platform admin: any account except their own
 * - an agency admin: staff of their own agency (needs users.manage) or client
 *   logins of their own agency (needs clients.manage); never a platform admin
 * The user can sign in with just their password afterwards and set 2FA up
 * again (a platform admin is sent straight to setup).
 */
export const resetUserMfaFn = createServerFn({ method: 'POST' })
  .validator(mfaResetSchema)
  .handler(async ({ data }): Promise<{ removed: number }> => {
    const actor = await requireSignedIn()
    if (data.user_id === actor.id) {
      throw new UserError("You can't reset your own two-factor sign-in. Ask another admin.")
    }
    const admin = getSupabaseAdminClient()
    const { data: target } = await admin
      .from('user_profiles')
      .select('user_id, full_name, organization_id, is_platform_admin, role:roles(key)')
      .eq('user_id', data.user_id)
      .maybeSingle()
    const t = target as unknown as {
      user_id: string
      full_name: string
      organization_id: string
      is_platform_admin: boolean
      role: { key: string } | null
    } | null
    if (!t) throw new Error('User not found')

    if (actor.isPlatformAdmin) {
      await requirePlatformAdmin()
    } else {
      const user = await requireUser()
      if (!isAdminRole(user.role)) throw new AuthError('FORBIDDEN', 'Admin access required')
      if (t.organization_id !== user.organizationId || t.is_platform_admin) {
        throw new Error('User not found')
      }
      const needed =
        t.role?.key === 'CLIENT' ? PERMISSIONS.CLIENTS_MANAGE : PERMISSIONS.USERS_MANAGE
      if (!hasPermission(user, needed)) {
        throw new AuthError('FORBIDDEN', `Missing permission: ${needed}`)
      }
    }

    const { data: list, error } = await admin.auth.admin.mfa.listFactors({ userId: t.user_id })
    if (error) throw new Error(error.message)
    let removed = 0
    for (const f of list?.factors ?? []) {
      const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: t.user_id })
      if (delErr) throw new Error(delErr.message)
      removed++
    }
    await writeAudit({
      actorUserId: actor.id,
      // Into the affected user's organization, so their agency sees it.
      organizationId: t.organization_id,
      action: 'MFA_RESET',
      entityType: 'USER',
      entityId: t.user_id,
      newValues: { full_name: t.full_name, factors_removed: removed },
    })
    return { removed }
  })

/**
 * Change your own password. The current password is checked first (a stolen,
 * still-open session must not be enough to lock the owner out).
 */
export const changePasswordFn = createServerFn({ method: 'POST' })
  .validator(changePasswordSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const user = await requireUser()
    await assertCurrentPassword(user.email, data.current_password)

    const supabase = getSupabaseServerClient()
    const { error } = await supabase.auth.updateUser({ password: data.new_password })
    if (error) throw new Error(error.message)
    await writeAudit({
      actorUserId: user.id,
      organizationId: user.organizationId,
      action: 'PASSWORD_CHANGED',
      entityType: 'USER',
      entityId: user.id,
    })
    return { ok: true }
  })
