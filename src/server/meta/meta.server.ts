import { createServerOnlyFn } from '@tanstack/react-start'
import { getServerEnv } from '@/lib/env/env.server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin.server'
import { dec } from '@/lib/money/money'

/**
 * Meta Marketing (Graph) API client — SERVER ONLY.
 *
 * Reads ad account data from the connected Business Portfolio using a
 * System User access token. Read-only (ads_read) — this integration never
 * writes back to Meta. `createServerOnlyFn` guarantees a runtime error if
 * this module is ever reached from the browser bundle.
 */

/** Meta's numeric account_status codes — informational display only, never
 * mapped onto our internal ad_accounts.status (that stays admin-controlled,
 * spec §19). */
const META_ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1: 'Active',
  2: 'Disabled',
  3: 'Unsettled',
  7: 'Pending risk review',
  8: 'Pending settlement',
  9: 'In grace period',
  100: 'Pending closure',
  101: 'Closed',
  201: 'Any active',
  202: 'Any closed',
}

export function metaStatusLabel(code: number | null | undefined): string {
  if (code == null) return 'Unknown'
  return META_ACCOUNT_STATUS_LABELS[code] ?? `Unknown (${code})`
}

// Meta returns money fields (amount_spent, spend_cap) on the AdAccount
// object in the account currency's *minor unit* (cents for USD) — except
// for zero-decimal currencies, which are already the base unit. Getting
// this wrong is a 100x error, not a rounding error, so it's normalized once
// here rather than left for every caller to remember.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])

function minorToMajor(
  minorUnits: string | undefined,
  currency: string | undefined,
): string | null {
  if (minorUnits == null || minorUnits === '') return null
  const isZeroDecimal = currency ? ZERO_DECIMAL_CURRENCIES.has(currency) : false
  return isZeroDecimal
    ? dec(minorUnits).toFixed(0)
    : dec(minorUnits).div(100).toFixed(2)
}

export interface MetaAdAccountSummary {
  external_account_id: string
  name: string
  meta_status_code: number | null
  meta_status_label: string
  currency: string | null
  /** Major units (e.g. dollars) in `currency`, already converted from
   * Meta's minor-unit wire format — see minorToMajor. */
  amount_spent: string | null
  /** Major units (e.g. dollars) in `currency` — same conversion as
   * amount_spent. Never assume this is USD; check `currency` first. */
  spend_cap: string | null
  /** Meta's own "amount owed to Meta" for this account (Ads Manager's
   * Billing → "Current balance") — accrued spend since the last payment,
   * charged to the linked payment method once it hits Meta's threshold.
   * Distinct from both `spend_cap - amount_spent` (this app's "Remaining")
   * and this app's own "Current balance" (the assigned client's ledger
   * due) — never conflate these three. Same minor-unit conversion. */
  meta_balance: string | null
}

import type { MetaCredentialScope } from '@/lib/meta/credential-scope'

interface MetaConfig {
  token: string
  businessId: string
  apiVersion: string
}

export class MetaNotConfiguredError extends Error {
  constructor(scope: MetaCredentialScope) {
    super(
      scope.kind === 'platform'
        ? 'The platform has no Meta Business Portfolio connected. Set META_SYSTEM_USER_TOKEN and META_BUSINESS_ID, or configure them in Platform → Settings → Meta integration.'
        : 'This agency has no Meta Business Portfolio connected yet. Add a System User token and Business Portfolio ID in Settings → Meta integration.',
    )
    this.name = 'MetaNotConfiguredError'
  }
}

/** Setting keys, shared by `app_settings` (per agency) and `platform_settings`
 * (the platform's own) — must match src/server/settings/*.fns.ts. */
const SETTING_KEYS = {
  TOKEN: 'META_SYSTEM_USER_TOKEN',
  BUSINESS_ID: 'META_BUSINESS_ID',
  API_VERSION: 'META_API_VERSION',
} as const

/**
 * Resolves ONE credential set's Meta credentials.
 *
 * There are two kinds, and keeping them apart IS the isolation boundary:
 *
 *   - `{ kind: 'organization' }` — an agency that connected its own Business
 *     Portfolio. Rows live in `app_settings`, keyed by (organization_id, key),
 *     so two agencies' tokens never mix. **No credential env fallback**: an
 *     agency with nothing configured has no Meta integration, which is the
 *     correct answer, not a degraded one.
 *   - `{ kind: 'platform' }` — Rush Tracker itself, whose portfolio holds the
 *     platform-owned ad account pool. Rows live in `platform_settings`, which
 *     has no organization_id at all, falling back to the META_* env vars.
 *
 * **The META_* env vars are the PLATFORM's credentials, not org zero's.** They
 * point at the portfolio containing the pool, and before migration 000037 they
 * were reachable as xRush Agency's own — which meant xRush's Settings screen
 * could rotate the token for a portfolio the platform owns, and every other
 * agency was one missing guard away from borrowing it. Now nothing an agency
 * can edit reaches them.
 *
 * The value is read fresh on every call rather than process-lifetime cached
 * (unlike getServerEnv()) — the whole point of DB-backed credentials is that a
 * change takes effect without a redeploy. Callers resolve this once per
 * operation and thread the result through, not per Graph API call.
 */
const getMetaConfig = createServerOnlyFn(
  async (scope: MetaCredentialScope): Promise<MetaConfig> => {
    const admin = getSupabaseAdminClient()
    const isPlatform = scope.kind === 'platform'

    const query = isPlatform
      ? admin.from('platform_settings').select('key, value')
      : admin
          .from('app_settings')
          .select('key, value')
          .eq('organization_id', scope.organizationId)
    const { data, error } = await query.in('key', Object.values(SETTING_KEYS))
    // Best-effort on a query failure: the platform still falls through to the
    // env vars rather than breaking every pool Meta feature, but it's logged,
    // since a genuine DB outage should be visible somewhere. An agency has
    // nothing to fall back to, so it surfaces as "not configured" —
    // deliberately, rather than borrowing the platform's.
    if (error) {
      console.error('[meta] settings lookup failed:', error.message)
    }
    const db = new Map(
      (data ?? []).map((r) => [r.key as string, r.value as string | null]),
    )

    const env = getServerEnv()

    // Only the two CREDENTIALS are gated on the platform scope. The Graph API
    // version is a protocol version, not tenant data — every agency may use
    // the deployment's configured default unless they pin their own.
    const token = db.get(SETTING_KEYS.TOKEN) || (isPlatform ? env.META_SYSTEM_USER_TOKEN : undefined)
    const businessId =
      db.get(SETTING_KEYS.BUSINESS_ID) || (isPlatform ? env.META_BUSINESS_ID : undefined)
    const apiVersion = db.get(SETTING_KEYS.API_VERSION) || env.META_API_VERSION

    if (!token || !businessId) {
      throw new MetaNotConfiguredError(scope)
    }
    return { token, businessId, apiVersion }
  },
)

/** True when this credential set resolves (an agency that connected its own
 * portfolio, or the platform's own credentials) — used by the cron to skip
 * agencies that haven't connected one, without treating that as an error. */
export async function isMetaConfigured(
  scope: MetaCredentialScope,
): Promise<boolean> {
  try {
    await getMetaConfig(scope)
    return true
  } catch {
    return false
  }
}

interface GraphErrorBody {
  error?: { message: string; type?: string; code?: number }
}

async function graphGet<T>(
  path: string,
  params: Record<string, string>,
  config: MetaConfig,
): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${config.apiVersion}/${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('access_token', config.token)

  const res = await fetch(url.toString())
  const body = (await res.json()) as GraphErrorBody & Record<string, unknown>
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `Meta API request failed (${res.status})`)
  }
  return body as T
}

async function graphPost(
  path: string,
  params: Record<string, string>,
  config: MetaConfig,
): Promise<void> {
  const body = new URLSearchParams({ ...params, access_token: config.token })

  const res = await fetch(`https://graph.facebook.com/${config.apiVersion}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json()) as GraphErrorBody & Record<string, unknown>
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `Meta API request failed (${res.status})`)
  }
}

function toSummary(raw: {
  account_id?: string
  name?: string
  account_status?: number
  currency?: string
  amount_spent?: string
  spend_cap?: string
  balance?: string
}): MetaAdAccountSummary {
  return {
    external_account_id: raw.account_id ?? '',
    name: raw.name ?? '',
    meta_status_code: raw.account_status ?? null,
    meta_status_label: metaStatusLabel(raw.account_status),
    currency: raw.currency ?? null,
    // Normalized to major units (e.g. dollars, not cents) — see
    // minorToMajor's comment. Never the raw Graph API value.
    amount_spent: minorToMajor(raw.amount_spent, raw.currency),
    spend_cap: minorToMajor(raw.spend_cap, raw.currency),
    meta_balance: minorToMajor(raw.balance, raw.currency),
  }
}

const AD_ACCOUNT_FIELDS =
  'account_id,name,account_status,currency,amount_spent,spend_cap,balance'

/** Fetch a single ad account's live details by its Meta account id. */
export async function fetchMetaAdAccount(
  externalAccountId: string,
  scope: MetaCredentialScope,
): Promise<MetaAdAccountSummary> {
  const config = await getMetaConfig(scope)
  const actId = externalAccountId.startsWith('act_')
    ? externalAccountId
    : `act_${externalAccountId}`
  const raw = await graphGet<Parameters<typeof toSummary>[0]>(
    actId,
    { fields: AD_ACCOUNT_FIELDS },
    config,
  )
  return toSummary(raw)
}

const MAX_PAGES = 10

async function listEdge(
  businessId: string,
  edge: 'owned_ad_accounts' | 'client_ad_accounts',
  config: MetaConfig,
): Promise<Array<MetaAdAccountSummary>> {
  const results: Array<MetaAdAccountSummary> = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      fields: AD_ACCOUNT_FIELDS,
      limit: '100',
    }
    if (after) params.after = after
    const body = await graphGet<{
      data: Array<Parameters<typeof toSummary>[0]>
      paging?: { cursors?: { after?: string }; next?: string }
    }>(`${businessId}/${edge}`, params, config)
    results.push(...body.data.map(toSummary))
    after = body.paging?.next ? body.paging.cursors?.after : undefined
    if (!after) break
  }
  return results
}

/**
 * List every ad account reachable through the connected Business Portfolio —
 * both accounts it owns outright (`owned_ad_accounts`) and accounts shared
 * into it from clients' own Business Managers (`client_ad_accounts`, the
 * normal shape for an agency: most managed accounts live here, not in
 * owned_ad_accounts). Deduped by account id in case one shows up in both.
 */
export async function listMetaBusinessAdAccounts(
  scope: MetaCredentialScope,
): Promise<Array<MetaAdAccountSummary>> {
  const config = await getMetaConfig(scope)
  const [owned, client] = await Promise.all([
    listEdge(config.businessId, 'owned_ad_accounts', config),
    listEdge(config.businessId, 'client_ad_accounts', config),
  ])
  const byId = new Map<string, MetaAdAccountSummary>()
  for (const account of [...owned, ...client]) {
    byId.set(account.external_account_id, account)
  }
  return [...byId.values()]
}

/**
 * Write a new spend_cap to a Meta ad account. WRITE — the only mutating
 * call in this integration; everything else in this file is read-only
 * (ads_read). Requires the token to actually hold ads_management (checked
 * at call time by Meta, not here — a permission error surfaces as a normal
 * thrown Error).
 *
 * UNIT TRAP, verified against Meta's docs before shipping: reading
 * spend_cap returns **minor units** (cents for USD — see minorToMajor), but
 * writing it takes **major units** (standard denomination, e.g. "100" or
 * "100.00" for $100 USD) — the API is asymmetric between GET and POST for
 * this exact field. Do NOT multiply by 100 here; `spendCapMajorUnits` is
 * passed straight through as Meta expects it.
 */
export async function updateMetaAdAccountSpendCap(
  externalAccountId: string,
  spendCapMajorUnits: string,
  scope: MetaCredentialScope,
): Promise<void> {
  const config = await getMetaConfig(scope)
  const actId = externalAccountId.startsWith('act_')
    ? externalAccountId
    : `act_${externalAccountId}`
  await graphPost(actId, { spend_cap: spendCapMajorUnits }, config)
}
