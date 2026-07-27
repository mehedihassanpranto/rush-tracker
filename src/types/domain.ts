import type { ClientStatus } from '@/lib/auth/types'

export type { ClientStatus }

export type AdAccountStatus = 'AVAILABLE' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
export type AssignmentStatus = 'ACTIVE' | 'RELEASED'

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
  // NUMERIC comes back from supabase-js as a string — format with money helpers.
  current_limit_usd: string
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

/** Ad account plus its current active assignment's client, if any. */
export interface AdAccountWithClient extends AdAccount {
  current_client: Pick<Client, 'id' | 'client_code' | 'name'> | null
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
  status: LimitRequestStatus
  requested_at: string
  reviewed_at: string | null
  admin_note: string | null
  rejection_reason: string | null
  created_at: string
}

/** Limit request joined with client + account display fields. */
export interface LimitRequestWithRefs extends LimitRequest {
  client: Pick<Client, 'id' | 'client_code' | 'name'> | null
  ad_account: Pick<AdAccount, 'id' | 'account_code' | 'name'> | null
}

/** Approval-screen payload: request, live account limit, proof + staleness. */
export interface LimitRequestDetail extends LimitRequestWithRefs {
  account_current_limit_usd: string | null
  /** This client's configured USD rate — the default rate for approval. */
  client_usd_rate: string | null
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
  client: Pick<Client, 'id' | 'client_code' | 'name'> | null
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
  read_at: string | null
  created_at: string
}

