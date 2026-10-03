import { createServerFn } from '@tanstack/react-start'
import { getRequestUrl } from '@tanstack/react-start/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { getServerEnv } from '@/lib/env/env.server'
import { requireUser } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import {
  checkRateLimit,
  rateLimitMessage,
  recordAttempt,
} from '@/server/auth/rate-limit.service'
import { assertCurrentPassword, requestIp } from '@/server/auth/password-check.service'
import { changeEmailSchema, confirmEmailChangeSchema } from '@/schemas/security'

/**
 * Change your own sign-in email.
 *
 * Supabase's "secure email change" is on: a link goes to BOTH the current and
 * the new address, and the email only changes once both are clicked — so
 * neither a stolen session nor a typo can move the account to an address its
 * owner doesn't control. The links point at /confirm-email (the "Change email
 * address" template in Supabase → Authentication → Emails, see
 * docs/DEPLOYMENT-HOSTINGER.md §4), never at Supabase's own verify URL, which
 * would sign in whoever clicks it.
 */

export interface EmailStatus {
  email: string
  /** address waiting for confirmation, if a change is in progress */
  pending_email: string | null
}

export const getEmailStatusFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<EmailStatus> => {
    await requireUser()
    const supabase = getSupabaseServerClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) throw new Error(error?.message ?? 'Not signed in')
    return { email: data.user.email ?? '', pending_email: data.user.new_email ?? null }
  },
)

export const requestEmailChangeFn = createServerFn({ method: 'POST' })
  .validator(changeEmailSchema)
  .handler(async ({ data }): Promise<{ pending_email: string }> => {
    const user = await requireUser()
    if (data.new_email === user.email.toLowerCase()) {
      throw new Error('That is already your sign-in email.')
    }
    await assertCurrentPassword(user.email, data.current_password)

    const admin = getSupabaseAdminClient()
    const { data: taken } = await admin.rpc('find_auth_user_by_email', { p_email: data.new_email })
    if ((taken as Array<unknown> | null)?.length) {
      throw new Error('That email address is already used by another account.')
    }

    // Each request emails the new address, so limit it per address: a
    // signed-in user must not be able to flood someone else's inbox.
    const ip = requestIp()
    const limit = await checkRateLimit(admin, 'reset', data.new_email, ip)
    if (!limit.allowed) throw new Error(rateLimitMessage(limit.retryAfterMinutes))
    await recordAttempt(admin, 'reset', data.new_email, ip, true)

    const supabase = getSupabaseServerClient()
    const { error } = await supabase.auth.updateUser(
      { email: data.new_email },
      { emailRedirectTo: `${getRequestUrl().origin}/confirm-email` },
    )
    if (error) {
      if (error.code === 'email_exists') {
        throw new Error('That email address is already used by another account.')
      }
      if (error.code === 'over_email_send_rate_limit') {
        throw new Error('Too many emails sent. Please try again in an hour.')
      }
      console.error('[email-change] updateUser failed', error.code, error.message)
      throw new Error('Could not send the confirmation emails. Please try again later.')
    }

    await writeAudit({
      actorUserId: user.id,
      organizationId: user.organizationId,
      action: 'EMAIL_CHANGE_REQUESTED',
      entityType: 'USER',
      entityId: user.id,
      oldValues: { email: user.email },
      newValues: { email: data.new_email },
    })
    return { pending_email: data.new_email }
  })

export type ConfirmEmailChangeResult =
  | { status: 'partial' }
  | { status: 'done'; email: string }

/**
 * Apply one confirmation link. No guard on purpose: the link is opened from
 * an inbox, often on another device, and the unguessable single-use token IS
 * the authorization (same as a password-reset link). Verified on a throwaway
 * client and the session Supabase hands back is ended at once, so confirming
 * never signs anyone in.
 */
export const confirmEmailChangeFn = createServerFn({ method: 'POST' })
  .validator(confirmEmailChangeSchema)
  .handler(async ({ data }): Promise<ConfirmEmailChangeResult> => {
    const env = getServerEnv()
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: result, error } = await client.auth.verifyOtp({
      token_hash: data.token_hash,
      type: 'email_change',
    })
    if (error) throw new Error('This link is invalid, has expired, or was already used.')
    // First of the two links: accepted, the other address still has to confirm.
    if (!result.session || !result.user) return { status: 'partial' }

    await client.auth.signOut({ scope: 'local' })
    const user = result.user
    const { data: profile } = await getSupabaseAdminClient()
      .from('user_profiles')
      .select('organization_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (profile) {
      await writeAudit({
        actorUserId: user.id,
        organizationId: (profile as { organization_id: string }).organization_id,
        action: 'EMAIL_CHANGED',
        entityType: 'USER',
        entityId: user.id,
        newValues: { email: user.email },
      })
    }
    return { status: 'done', email: user.email ?? '' }
  })
