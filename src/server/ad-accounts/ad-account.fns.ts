import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { requireAdmin } from '@/server/auth/guards.server'
import { writeAudit } from '@/server/audit/audit.service'
import { PERMISSIONS } from '@/lib/permissions/permissions'
import {
  adAccountCreateSchema,
  adAccountRenameSchema,
  adAccountStatusSchema,
  adAccountUpdateSchema,
} from '@/schemas/ad-account'
import type {
  AdAccount,
  AdAccountClient,
  AdAccountWithClient,
  AssignmentWithRefs,
} from '@/types/domain'

type ActiveAssignmentRow = {
  ad_account_id: string
  client: Pick<AdAccountClient, 'id' | 'client_code' | 'name'> | null
}

async function currentClientMap(
  accountIds: Array<string>,
): Promise<Map<string, AdAccountClient>> {
  const map = new Map<string, AdAccountClient>()
  if (accountIds.length === 0) return map
  const admin = getSupabaseAdminClient()
  const { data } = await admin
    .from('ad_account_assignments')
    .select('ad_account_id, client:clients(id, client_code, name)')
    .eq('status', 'ACTIVE')
    .in('ad_account_id', accountIds)

  const rows = (data ?? []) as unknown as Array<ActiveAssignmentRow>
  const distinctClientIds = [
    ...new Set(rows.flatMap((r) => (r.client ? [r.client.id] : []))),
  ]

  // current_due is ledger-derived (spec §35), never a stored column. A
  // single client (the account detail page's [data.id] call) uses the
  // cheap single-client client_financials() RPC instead of paying for the
  // bulk all_client_dues() aggregate just to resolve one row; the list
  // page's many-clients call still uses the bulk RPC (one round trip either
  // way, never O(accounts) due lookups).
  const dueByClient = new Map<string, string>()
  if (distinctClientIds.length === 1) {
    const { data: financials } = await admin.rpc('client_financials', {
      p_client_id: distinctClientIds[0],
    })
    const due = (
      financials as Array<{ current_due: string | number }> | null
    )?.[0]?.current_due
    dueByClient.set(distinctClientIds[0], String(due ?? '0'))
  } else if (distinctClientIds.length > 1) {
    const { data: dueRows } = await admin.rpc('all_client_dues')
    for (const r of (dueRows ?? []) as Array<{
      client_id: string
      current_due: string | number
    }>) {
      dueByClient.set(r.client_id, String(r.current_due))
    }
  }

  for (const row of rows) {
    if (row.client) {
      map.set(row.ad_account_id, {
        ...row.client,
        current_due: dueByClient.get(row.client.id) ?? '0',
      })
    }
  }
  return map
}

export const listAdAccountsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<AdAccountWithClient>> => {
    await requireAdmin(PERMISSIONS.AD_ACCOUNTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data, error } = await admin
      .from('ad_accounts')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)

    const accounts = data as Array<AdAccount>
    const clients = await currentClientMap(accounts.map((a) => a.id))
    return accounts.map((a) => ({
      ...a,
      current_client: clients.get(a.id) ?? null,
    }))
  },
)

export const getAdAccountFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<AdAccountWithClient> => {
    await requireAdmin(PERMISSIONS.AD_ACCOUNTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: account, error } = await admin
      .from('ad_accounts')
      .select('*')
      .eq('id', data.id)
      .single()
    if (error) throw new Error(error.message)
    const clients = await currentClientMap([data.id])
    return { ...(account as AdAccount), current_client: clients.get(data.id) ?? null }
  })

export const listAssignmentHistoryFn = createServerFn({ method: 'GET' })
  .validator(z.object({ ad_account_id: z.uuid() }))
  .handler(async ({ data }): Promise<Array<AssignmentWithRefs>> => {
    await requireAdmin(PERMISSIONS.AD_ACCOUNTS_VIEW)
    const admin = getSupabaseAdminClient()
    const { data: rows, error } = await admin
      .from('ad_account_assignments')
      .select(
        'id, ad_account_id, client_id, opening_limit_usd, closing_limit_usd, assigned_at, released_at, status, notes, created_at, client:clients(id, client_code, name)',
      )
      .eq('ad_account_id', data.ad_account_id)
      .order('assigned_at', { ascending: false })
    if (error) throw new Error(error.message)
    return (rows ?? []).map((r) => ({
      ...(r as unknown as AssignmentWithRefs),
      ad_account: null,
    }))
  })

export const createAdAccountFn = createServerFn({ method: 'POST' })
  .validator(adAccountCreateSchema)
  .handler(async ({ data }): Promise<AdAccount> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()
    const { data: account, error } = await admin
      .from('ad_accounts')
      .insert({
        name: data.name,
        external_account_id: data.external_account_id ?? null,
        platform: data.platform,
        current_limit_usd: data.current_limit_usd,
        usd_rate: data.usd_rate,
        status: data.status,
      })
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'AD_ACCOUNT_CREATED',
      entityType: 'AD_ACCOUNT',
      entityId: account.id,
      newValues: account,
    })
    return account as AdAccount
  })

export const updateAdAccountFn = createServerFn({ method: 'POST' })
  .validator(adAccountUpdateSchema)
  .handler(async ({ data }): Promise<AdAccount> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: before } = await admin
      .from('ad_accounts')
      .select('*')
      .eq('id', data.id)
      .single()

    const { data: account, error } = await admin
      .from('ad_accounts')
      .update({
        external_account_id: data.external_account_id ?? null,
        platform: data.platform,
        current_limit_usd: data.current_limit_usd,
        usd_rate: data.usd_rate,
      })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'AD_ACCOUNT_UPDATED',
      entityType: 'AD_ACCOUNT',
      entityId: data.id,
      oldValues: before ?? null,
      newValues: account,
    })
    return account as AdAccount
  })

export const renameAdAccountFn = createServerFn({ method: 'POST' })
  .validator(adAccountRenameSchema)
  .handler(async ({ data }): Promise<AdAccount> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: before } = await admin
      .from('ad_accounts')
      .select('name')
      .eq('id', data.id)
      .single()

    // Only `name` changes — id and account_code stay stable so all historical
    // references remain intact (spec §18, Rule 25).
    const { data: account, error } = await admin
      .from('ad_accounts')
      .update({ name: data.name })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'AD_ACCOUNT_RENAMED',
      entityType: 'AD_ACCOUNT',
      entityId: data.id,
      oldValues: { name: (before as { name: string } | null)?.name },
      newValues: { name: data.name },
    })
    return account as AdAccount
  })

export const setAdAccountStatusFn = createServerFn({ method: 'POST' })
  .validator(adAccountStatusSchema)
  .handler(async ({ data }): Promise<AdAccount> => {
    const actor = await requireAdmin(PERMISSIONS.AD_ACCOUNTS_MANAGE)
    const admin = getSupabaseAdminClient()

    const { data: account, error } = await admin
      .from('ad_accounts')
      .update({ status: data.status })
      .eq('id', data.id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)

    await writeAudit({
      actorUserId: actor.id,
      action: 'AD_ACCOUNT_STATUS_CHANGED',
      entityType: 'AD_ACCOUNT',
      entityId: data.id,
      newValues: { status: data.status },
    })
    return account as AdAccount
  })
