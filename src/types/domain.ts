import type { ClientStatus } from '@/lib/auth/types'

export type { ClientStatus }

export type AdAccountStatus = 'AVAILABLE' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
export type AssignmentStatus = 'ACTIVE' | 'RELEASED'

/**
 * prepaid: must pay the FULL total_cost_bdt up front, not editable.
 * partial: pays some amount up front (editable, 0 < amount <= total_cost),
 *   the rest becomes due — this was the original, single 'prepaid' meaning
 *   before the segment split (2026-08-23).
 * postpaid: original app behavior — no payment at request time, full
 *   amount becomes due, settled later via Pay Due.
 */
export type ClientSegment = 'prepaid' | 'partial' | 'postpaid'

export interface Client {
  id: string
  client_code: string
  name: string
  company_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  status: ClientStatus
  /** USD→BDT rate charged per dollar for this client. NUMERIC → string. */
  usd_rate: string
  /** prepaid: pays (fully or partially) up front with proof at request time.
   * postpaid: the original flow — full amount goes to due, settled later. */
  segment: ClientSegment
  created_at: string
  updated_at: string
}

export interface AdAccount {
  id: string
  account_code: string
  name: string
  external_account_id: string | null
  platform: string
  status: AdAccountStatus
  /**
   * True when the PLATFORM owns this account (the central pool) rather than an
   * agency. A pool account has no organization_id of its own; an agency reaches
   * it through a row in platform_account_grants. See
   * src/server/ad-accounts/scope.server.ts.
   */
  is_platform: boolean
  // NUMERIC comes back from supabase-js as a string — format with money helpers.
  current_limit_usd: string
  /**
   * USD→BDT rate charged per dollar on this account. Takes precedence over the
   * client's rate for limit requests; '0' means unset and falls back to it.
   */
  usd_rate: string
  /** Admin-entered billing threshold (USD) — Meta's own "you'll pay when
   * your balance reaches $X" auto-charge trigger, shown on the account's
   * Billing page. Not reachable via the Meta API (confirmed against the
   * live Graph API), so this is a manually-maintained reference value only
   * — never compared against or synced with any Meta-fetched figure. */
  threshold_usd: string
  /** True when current_limit_usd hasn't been confirmed pushed to Meta's
   * spend_cap after an approval — see spend-cap-sync.server.ts. Never true
   * for unlinked or non-USD accounts (never auto-synced, not a failure). */
  meta_sync_pending: boolean
  meta_sync_error: string | null
  meta_sync_attempted_at: string | null
  /** Meta account_status code observed on the most recent cron sync — used
   * only to detect a transition into Disabled for Telegram alerting. */
  meta_last_status_code: number | null
  /** True once a Telegram low-balance alert has been sent for the account's
   * current below-threshold period; resets once it recovers. */
  meta_low_balance_alerted: boolean
  created_at: string
  updated_at: string
}

export interface Assignment {
  id: string
  ad_account_id: string
  client_id: string
  opening_limit_usd: string
  closing_limit_usd: string | null
  assigned_at: string
  released_at: string | null
  status: AssignmentStatus
  notes: string | null
  created_at: string
}

/** The current-assignment client fields carried alongside an ad account.
 * current_due is ledger-derived (spec §35), never a stored Client column —
 * merged in from all_client_dues(), not Pick<Client, ...>. */
export type AdAccountClient = Pick<
  Client,
  'id' | 'client_code' | 'name' | 'usd_rate'
> & {
  current_due: string
}

/** Ad account plus its current active assignment's client, if any. */
export interface AdAccountWithClient extends AdAccount {
  current_client: AdAccountClient | null
}

/** Assignment row joined with account + client display fields (for history). */
export interface AssignmentWithRefs extends Assignment {
  ad_account: Pick<AdAccount, 'id' | 'account_code' | 'name'> | null
  client: Pick<Client, 'id' | 'client_code' | 'name'> | null
}

// ---------------------------------------------------------------------------
// Phase 3 — limit requests, exchange rates, ledger
// ---------------------------------------------------------------------------

export type LimitRequestStatus =
  | 'PENDING'
  /** Only reachable for a platform-assigned account (ad_accounts.is_platform):
   * the agency reviewed the request and sent it to the platform instead of
   * approving directly — the agency cannot approve a platform-assigned
   * account's request itself. Resolves to APPROVED/REJECTED like any other
   * request once the platform reviews it. */
  | 'PENDING_PLATFORM_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'

export interface LimitRequest {
  id: string
  request_number: string
  client_id: string
  ad_account_id: string
  assignment_id: string
  opening_balance_usd: string
  requested_amount_usd: string
  approved_amount_usd: string | null
  default_usd_rate: string
  approved_usd_rate: string | null
  expected_new_limit_usd: string
  approved_new_limit_usd: string | null
  bdt_charge: string | null
  /** The requesting client's segment, snapshotted at request time — not a
   * live join, so a client's segment changing later never rewrites past
   * requests. */
  segment: ClientSegment
  /** requested_amount_usd * default_usd_rate, frozen at submission. Distinct
   * from bdt_charge (computed at approval from the admin-editable amount). */
  total_cost_bdt: string
  /** What the client paid up front (prepaid only; '0' for postpaid). */
  amount_paid_bdt: string
  /** total_cost_bdt - amount_paid_bdt, computed server-side at submission.
   * Informational only — the client's real running due is always the
   * ledger (client_financials()), never this column. */
  due_balance_bdt: string
  status: LimitRequestStatus
  requested_at: string
  reviewed_at: string | null
  approved_at: string | null
  /** Set only when an agency sends a platform-assigned account's request up
   * for platform review — null for every other request. */
  sent_to_platform_at: string | null
  sent_to_platform_by: string | null
  admin_note: string | null
  rejection_reason: string | null
  created_at: string
}

/** Limit request joined with client + account display fields. */
export interface LimitRequestWithRefs extends LimitRequest {
  client: Pick<Client, 'id' | 'client_code' | 'name'> | null
  /** is_platform decides whether this request can be approved directly (the
   * agency's own call) or must be sent to the platform instead — see
   * canApprovePlatformRequest() in limit-request.fns.ts. */
  ad_account: Pick<AdAccount, 'id' | 'account_code' | 'name' | 'is_platform'> | null
}

/** Approval-screen payload: request, live account limit, proof + staleness. */
export interface LimitRequestDetail extends LimitRequestWithRefs {
  account_current_limit_usd: string | null
  /**
   * The rate governing this request — the ad account's own rate, falling back
   * to the client's when unset. Prefills the editable rate on approval.
   */
  applicable_usd_rate: string | null
  has_proof: boolean
  is_stale: boolean
}

export interface ExchangeRate {
  id: string
  rate: string
  effective_from: string
  created_at: string
}

export interface ProofFile {
  id: string
  original_file_name: string | null
  mime_type: string | null
  file_size: number | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Phase 4 — ledger, financials, adjustments
// ---------------------------------------------------------------------------

export type LedgerEntryType =
  | 'LIMIT_APPROVAL'
  | 'PAYMENT'
  | 'ADJUSTMENT_DEBIT'
  | 'ADJUSTMENT_CREDIT'
  | 'REVERSAL'

export interface LedgerEntry {
  id: string
  transaction_number: string
  client_id: string
  type: LedgerEntryType
  reference_type: string | null
  reference_id: string | null
  usd_amount: string | null
  usd_rate: string | null
  bdt_amount: string | null
  debit_bdt: string
  credit_bdt: string
  description: string | null
  created_at: string
}

export interface LedgerEntryWithClient extends LedgerEntry {
  client: Pick<Client, 'id' | 'client_code' | 'name'> | null
}

/** Ledger row with the running balance after it (chronological). */
export interface LedgerEntryWithBalance extends LedgerEntry {
  balance_after: string
}

export interface ClientFinancials {
  total_debit: string
  total_credit: string
  current_due: string
  total_approved_usd: string
  /** Current due converted to USD at the current default rate (approximate). */
  current_due_usd: string
}

export type AdjustmentType = 'ADD_DUE' | 'REDUCE_DUE' | 'REVERSAL'

export interface Adjustment {
  id: string
  adjustment_number: string
  client_id: string
  type: AdjustmentType
  amount_bdt: string
  reference_type: string | null
  reference_id: string | null
  reason: string
  internal_note: string | null
  created_at: string
}

export interface AdjustmentWithClient extends Adjustment {
  client: Pick<Client, 'id' | 'client_code' | 'name'> | null
}

// ---------------------------------------------------------------------------
// Phase 5 — payments and payment requests
// ---------------------------------------------------------------------------

export type PaymentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'

export type PaymentRequestStatus =
  | 'REQUESTED'
  | 'PAYMENT_SUBMITTED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'CANCELLED'

export interface Payment {
  id: string
  payment_number: string
  client_id: string
  payment_request_id: string | null
  amount_bdt: string
  payment_method: string | null
  transaction_reference: string | null
  status: PaymentStatus
  submitted_at: string
  reviewed_at: string | null
  admin_note: string | null
  rejection_reason: string | null
  created_at: string
}

export interface PaymentWithClient extends Payment {
  client: Pick<Client, 'id' | 'client_code' | 'name' | 'segment'> | null
}

export interface PaymentRequest {
  id: string
  request_number: string
  client_id: string
  requested_amount_bdt: string
  status: PaymentRequestStatus
  message: string | null
  due_date: string | null
  created_at: string
}

export interface PaymentRequestWithClient extends PaymentRequest {
  client: Pick<Client, 'id' | 'client_code' | 'name'> | null
}

/** Client due snapshot for the pay screen (spec §42, §49). */
export interface DueSummary {
  current_due: string
  pending_total: string
  outstanding: string // due minus pending (what can still be submitted)
}

// ---------------------------------------------------------------------------
// Phase 7 — notifications
// ---------------------------------------------------------------------------

export interface Notification {
  id: string
  user_id: string
  type: string
  title: string
  message: string | null
  entity_type: string | null
  entity_id: string | null
  /** Which client this notification is about, when known — null for
   * admin-facing notifications (see notification.service.ts). */
  client_id: string | null
  read_at: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Finance — USD buy/sell margin tracking (forex spread revenue, post-Phase-8).
// A separate bookkeeping layer alongside the real ledger, not a replacement
// for it. One row per transaction: rates are entered, amounts and margin
// are DB-computed from them (usd_amount * rate).
// See supabase/migrations/20260723000030_finance_rates.sql.
// ---------------------------------------------------------------------------

export interface UsdMarginEntry {
  id: string
  transaction_date: string
  usd_amount: string
  buying_rate: string
  buying_amount_bdt: string
  selling_rate: string
  selling_amount_bdt: string
  margin_bdt: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Organizations — multi-tenant subscription conversion, Phase 2.
// See supabase/migrations/20260723000031_multi_tenant_foundation.sql.
// ---------------------------------------------------------------------------

export type OrganizationSubscriptionStatus = 'active' | 'suspended' | 'cancelled'

export interface Organization {
  id: string
  name: string
  subscription_status: OrganizationSubscriptionStatus
  plan: string | null
  notes: string | null
  suspended_at: string | null
  created_at: string
}

