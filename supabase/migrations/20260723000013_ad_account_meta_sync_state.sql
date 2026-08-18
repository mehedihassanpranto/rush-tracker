-- ----------------------------------------------------------------------------
-- Meta spend_cap auto-sync state (post-Phase-8 addition).
--
-- After a limit request is approved, the system now auto-pushes the new
-- current_limit_usd to the linked Meta ad account's spend_cap. These
-- columns track whether that push is confirmed in sync, so a failure never
-- silently leaves current_limit_usd and Meta's spend_cap disagreeing —
-- meta_sync_pending flags it, the daily /api/cron/meta-sync job retries it,
-- and an admin can force a retry from the ad account detail page.
-- ----------------------------------------------------------------------------
alter table public.ad_accounts
  add column if not exists meta_sync_pending boolean not null default false;
alter table public.ad_accounts
  add column if not exists meta_sync_error text;
alter table public.ad_accounts
  add column if not exists meta_sync_attempted_at timestamptz;

comment on column public.ad_accounts.meta_sync_pending is
  'True when current_limit_usd has not been confirmed pushed to Meta spend_cap (an auto-sync attempt failed and is awaiting retry). Always false for accounts with no external_account_id or a non-USD Meta currency — those are never auto-synced, not failures.';
comment on column public.ad_accounts.meta_sync_error is
  'Most recent auto-sync failure message; cleared on the next successful sync.';
comment on column public.ad_accounts.meta_sync_attempted_at is
  'Timestamp of the most recent auto-sync attempt, success or failure.';
