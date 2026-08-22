-- ----------------------------------------------------------------------------
-- Meta alert transition state (post-Phase-8 addition).
--
-- The daily /api/cron/meta-sync job now Telegram-alerts on two Meta-detected
-- events: an account going Disabled, and an account's spend headroom
-- crossing LOW_BALANCE_THRESHOLD. Both must fire once per transition, not
-- re-alert every single day the account stays in that state — these columns
-- let the cron remember what it last saw so it can tell "still disabled"
-- apart from "just became disabled".
-- ----------------------------------------------------------------------------
alter table public.ad_accounts
  add column if not exists meta_last_status_code integer;
alter table public.ad_accounts
  add column if not exists meta_low_balance_alerted boolean not null default false;

comment on column public.ad_accounts.meta_last_status_code is
  'Meta account_status code observed on the most recent cron sync (see metaStatusLabel() for the code table). Used only to detect a transition into Disabled (code 2) for Telegram alerting — never drives any of our own business logic.';
comment on column public.ad_accounts.meta_low_balance_alerted is
  'True once a Telegram low-remaining-balance alert has been sent for the account''s CURRENT below-threshold period; reset to false once remaining recovers above LOW_BALANCE_THRESHOLD, so the next crossing alerts again.';
