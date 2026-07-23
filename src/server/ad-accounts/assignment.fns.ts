import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin, requireClientMembership } from '@/server/auth/guards.server'
import { notifyClientMembers } from '@/server/notifications/notification.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import { assignSchema, releaseSchema, transferSchema } from '@/schemas/ad-account'
import type {
  AdAccount,
  AdAccountWithClient,
  AssignmentWithRefs,
  Client,
} from '@/types/domain'

/** Active clients available as assignment/transfer targets. */
export const listActiveClientsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<Pick<Client, 'id' | 'client_code' | 'name'>>> => {
    await requireAdmin(PERMISSIONS.AD_ACCOUNTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('clients')
      .select('id, client_code, name')
      .eq('status', 'ACTIVE')
      .order('name')
    if (error) throw new Error(error.message)
    return data as Array<Pick<Client, 'id' | 'client_code' | 'name'>>
  },
)

/** Accounts with no active assignment (AVAILABLE/INACTIVE, not suspended). */
export const listAssignableAccountsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<AdAccount>> => {
    await requireAdmin(PERMISSIONS.AD_ACCOUNTS_ASSIGN)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('ad_accounts')
      .select('*')
      .eq('status', 'AVAILABLE')
      .order('name')
    if (error) throw new Error(error.message)
    return data as Array<AdAccount>
  },
)

/** Active accounts assigned to a specific client (for the client detail page). */
export const listClientAccountsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ client_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<AdAccountWithClient>> => {
    await requireAdmin(PERMISSIONS.CLIENTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: rows, error } = await admin
      .from('ad_account_assignments')
      .select('account:ad_accounts(*), client:clients(id, client_code, name)')
      .eq('client_id', data.client_id)
      .eq('status', 'ACTIVE')
    if (error) throw new Error(error.message)

    const parsed = (rows ?? []) as unknown as Array<{
      account: AdAccount | null
      client: Pick<Client, 'id' | 'client_code' | 'name'> | null
    }>
    return parsed.flatMap((r) =>
      r.account ? [{ ...r.account, current_client: r.client }] : [],
    )
  })

function rpcErrorMessage(message: string): string {
  // RPC RAISE EXCEPTION messages are already user-facing; supabase prefixes
  // some with context — keep the human part.
  return message.replace(/^.*?:\s*/, '').trim() || message
}

async function accountLabel(accountId: string): Promise<string> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('ad_accounts')
    .select('name, account_code')
    .eq('id', accountId)
    .maybeSingle()
  const a = data as { name: string; account_code: string } | null
  return a ? `${a.name} (${a.account_code})` : 'an ad account'
}

/** Client currently holding the account's active assignment, if any. */
async function currentAssignedClientId(
  accountId: string,
): Promise<string | null> {
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('ad_account_assignments')
    .select('client_id')
    .eq('ad_account_id', accountId)
    .eq('status', 'ACTIVE')
    .maybeSingle()
  return (data as { client_id: string } | null)?.client_id ?? null
}

export const assignAccountFn = createServerFn({ method: 'POST' })
  .validator(assignSchema)
  .handler(async ({ data }): Promise<{ assignment_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_ASSIGN)
    const admin = getSupabaseAdminClient()
    const { data: id, error } = await admin.rpc('assign_ad_account', {
      p_account_id: data.ad_account_id,
      p_client_id: data.client_id,
      p_actor: actor.id,
      p_notes: data.notes ?? null,
    })
    if (error) throw new Error(rpcErrorMessage(error.message))

    await notifyClientMembers(data.client_id, {
      type: 'ACCOUNT_ASSIGNED',
      title: 'Ad account assigned',
      message: `${await accountLabel(data.ad_account_id)} is now assigned to you`,
      entityType: 'AD_ACCOUNT',
      entityId: data.ad_account_id,
    })
    return { assignment_id: id as string }
  })

export const releaseAccountFn = createServerFn({ method: 'POST' })
  .validator(releaseSchema)
  .handler(async ({ data }): Promise<{ assignment_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_ASSIGN)
    const admin = getSupabaseAdminClient()

    // Capture the holding client before the RPC clears the active assignment.
    const releasedClientId = await currentAssignedClientId(data.ad_account_id)

    const { data: id, error } = await admin.rpc('release_ad_account', {
      p_account_id: data.ad_account_id,
      p_actor: actor.id,
      p_notes: data.notes ?? null,
    })
    if (error) throw new Error(rpcErrorMessage(error.message))

    if (releasedClientId) {
      await notifyClientMembers(releasedClientId, {
        type: 'ACCOUNT_RELEASED',
        title: 'Ad account released',
        message: `${await accountLabel(
          data.ad_account_id,
        )} is no longer assigned to you`,
        entityType: 'AD_ACCOUNT',
        entityId: data.ad_account_id,
      })
    }
    return { assignment_id: id as string }
  })

export const transferAccountFn = createServerFn({ method: 'POST' })
  .validator(transferSchema)
  .handler(async ({ data }): Promise<{ assignment_id: string }> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_TRANSFER)
    const admin = getSupabaseAdminClient()

    // Capture the losing client before the RPC re-points the assignment.
    const fromClientId = await currentAssignedClientId(data.ad_account_id)

    const { data: id, error } = await admin.rpc('transfer_ad_account', {
      p_account_id: data.ad_account_id,
      p_to_client_id: data.to_client_id,
      p_actor: actor.id,
      p_notes: data.notes ?? null,
    })
    if (error) throw new Error(rpcErrorMessage(error.message))

    const label = await accountLabel(data.ad_account_id)
    if (fromClientId && fromClientId !== data.to_client_id) {
      await notifyClientMembers(fromClientId, {
        type: 'ACCOUNT_TRANSFERRED',
        title: 'Ad account transferred',
        message: `${label} has been transferred to another organization`,
        entityType: 'AD_ACCOUNT',
        entityId: data.ad_account_id,
      })
    }
    await notifyClientMembers(data.to_client_id, {
      type: 'ACCOUNT_TRANSFERRED',
      title: 'Ad account assigned',
      message: `${label} has been transferred to you`,
      entityType: 'AD_ACCOUNT',
      entityId: data.ad_account_id,
    })
    return { assignment_id: id as string }
  })

// ----------------------------------------------------------------------------
// Client-facing (portal)
// ----------------------------------------------------------------------------

/** Ad accounts currently assigned to the signed-in client user's org. */
export const listMyAccountsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<AdAccount>> => {
    const { membership } = await requireClientMembership()
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('ad_account_assignments')
      .select('account:ad_accounts(*)')
      .eq('client_id', membership.clientId)
      .eq('status', 'ACTIVE')
    if (error) throw new Error(error.message)

    const parsed = (data ?? []) as unknown as Array<{ account: AdAccount | null }>
    return parsed.flatMap((r) => (r.account ? [r.account] : []))
  },
)

/** Full assignment history for the signed-in client user's org. */
export const listMyAssignmentHistoryFn = createServerFn({
  method: 'GET',
}).handler(async (): Promise<Array<AssignmentWithRefs>> => {
  const { membership } = await requireClientMembership()
  const admin = getSupabaseAdminClient()
  const { data, error } = await admin
    .from('ad_account_assignments')
    .select(
      'id, ad_account_id, client_id, opening_limit_usd, closing_limit_usd, assigned_at, released_at, status, notes, created_at, ad_account:ad_accounts(id, account_code, name)',
    )
    .eq('client_id', membership.clientId)
    .order('assigned_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => ({
    ...(r as unknown as AssignmentWithRefs),
    client: null,
  }))
})
