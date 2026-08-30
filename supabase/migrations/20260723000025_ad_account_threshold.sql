-- ============================================================================
-- Ad account billing threshold (manual, admin-entered)
--
-- Meta's Ads Manager Billing page shows "You'll pay when your balance
-- reaches $X" — the amount at which Meta auto-charges the linked payment
-- method. Confirmed live against the Graph API (fetched a real linked
-- account with an expanded field list, and probed candidate field names
-- directly) that this value is NOT exposed anywhere in the Marketing API —
-- it only exists in Meta's own billing-settings UI. So it cannot be synced
-- from Meta the way spend_cap/amount_spent/balance are; it's a plain
-- admin-entered reference value, maintained the same way current_limit_usd
-- is, with no live-data relationship to anything Meta-fetched.
-- ============================================================================

alter table public.ad_accounts
  add column if not exists threshold_usd numeric(18, 2) not null default 0
    check (threshold_usd >= 0);

comment on column public.ad_accounts.threshold_usd is
  'Admin-entered billing threshold (USD) — mirrors Meta''s own "you''ll pay when your balance reaches $X" auto-charge trigger from its Billing page. Not available via the Meta API; manually maintained, never synced.';
