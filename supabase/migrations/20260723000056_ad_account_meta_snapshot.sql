-- ============================================================================
-- Last-read Meta figures per ad account ("Meta snapshot").
--
-- Written by the Refresh buttons (platform pool list, agency ad accounts list)
-- and by the agency's live Meta reads, so the platform and the agency portal
-- show the same numbers and a Refresh on either side updates both. Each value
-- is read directly from the account's own Graph node — the business portfolio
-- edges return stale amount_spent/balance.
--
-- Display only: nothing financial is derived from these. current_limit_usd
-- stays admin-controlled and is never set from meta_spend_cap.
--
-- Major units in meta_currency (already converted from Meta's minor units).
-- Additive and nullable: existing rows read as "never refreshed".
-- ============================================================================

alter table public.ad_accounts
  add column if not exists meta_amount_spent numeric,
  add column if not exists meta_spend_cap numeric,
  add column if not exists meta_balance numeric,
  add column if not exists meta_currency text,
  add column if not exists meta_refreshed_at timestamptz;
