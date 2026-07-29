-- ============================================================================
-- Per-ad-account USD rate
--
-- Adds a USD→BDT rate to the ad account itself, set when the account is
-- created and editable afterwards. It takes precedence over the client's rate
-- when a limit request is raised or approved on that account, so an account
-- can be billed at its own rate regardless of who currently holds it.
--
-- A zero rate means "not set" and falls back to the client rate, so an account
-- is never billed at zero. Client-level USD conversions (current due, dashboard
-- totals) stay on the client rate — they aggregate across accounts, so no
-- single account rate applies.
--
-- Existing approvals keep their immutable snapshot (limit_requests
-- .approved_usd_rate, ledger_entries.usd_rate) and are untouched.
-- ============================================================================

alter table public.ad_accounts
  add column if not exists usd_rate numeric(10, 4) not null default 0;

-- Backfill assigned accounts from their current client so they keep billing at
-- exactly the rate they bill at today.
update public.ad_accounts a
set usd_rate = c.usd_rate
from public.ad_account_assignments asg
  join public.clients c on c.id = asg.client_id
where asg.ad_account_id = a.id
  and asg.status = 'ACTIVE'
  and a.usd_rate = 0
  and c.usd_rate > 0;

-- Unassigned accounts have no client to inherit from: seed them from the latest
-- configured global rate so the column is populated rather than blank.
update public.ad_accounts
set usd_rate = coalesce(
  (select rate from public.exchange_rates order by effective_from desc limit 1),
  0
)
where usd_rate = 0;

comment on column public.ad_accounts.usd_rate is
  'USD→BDT rate charged per dollar for limit requests on this account. Takes precedence over clients.usd_rate; 0 means unset and falls back to the client rate.';
