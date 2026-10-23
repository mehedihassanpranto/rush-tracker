-- ============================================================================
-- Agency dashboard period filter (owner request, 2026-10-23): USD spent on
-- Meta, limits approved and client payments — today, this week (from Sunday),
-- this month, last month, with a day-by-day breakdown.
--
--   meta_daily_spend      Meta's own spend per ad account per calendar day
--                         (Insights API, the account's own timezone and
--                         currency), cached so the dashboard never waits on
--                         Meta. Refreshed by the nightly meta-sync job (this
--                         month + last month) and the dashboard's Refresh
--                         button. DISPLAY ONLY — never a limit, never the
--                         platform's books (those use meta_spend_events, 000063).
--                         A fetched day with no spend is stored as 0, so
--                         "no spend" and "not fetched" stay distinguishable.
--   agency_daily_totals() limits approved (USD, billed BDT) and client
--                         payments per Asia/Dhaka day for a date range, from
--                         the ledger — exactly what admin_today_totals() counts
--                         for one day.
--
-- Rows go with their ad account (ON DELETE CASCADE). RLS on, zero policies,
-- grants revoked; the function is service_role only.
--
-- MANUAL ROLLBACK:
--   drop function public.agency_daily_totals(uuid, date, date);
--   drop table public.meta_daily_spend;
-- ============================================================================

create table public.meta_daily_spend (
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  spend_date    date not null,
  spend         numeric(18, 2) not null check (spend >= 0),
  currency      text,
  fetched_at    timestamptz not null default now(),
  primary key (ad_account_id, spend_date)
);
create index idx_meta_daily_spend_date on public.meta_daily_spend (spend_date);

alter table public.meta_daily_spend enable row level security;
revoke all on public.meta_daily_spend from anon, authenticated;

comment on table public.meta_daily_spend is
  'Meta Insights spend per ad account per day (account timezone/currency). Dashboard display only; refreshed nightly and on demand.';

create or replace function public.agency_daily_totals(p_organization_id uuid, p_from date, p_to date)
returns table (
  day                  date,
  approved_limit_usd   numeric,
  approved_billing_bdt numeric,
  collection_bdt       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (created_at at time zone 'Asia/Dhaka')::date as day,
    coalesce(sum(usd_amount) filter (where type = 'LIMIT_APPROVAL'), 0),
    coalesce(sum(debit_bdt) filter (where type = 'LIMIT_APPROVAL'), 0),
    coalesce(sum(credit_bdt) filter (where type = 'PAYMENT'), 0)
  from public.ledger_entries
  where organization_id = p_organization_id
    and (created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1
  order by 1
$$;

revoke all on function public.agency_daily_totals(uuid, date, date) from public, anon, authenticated;
grant execute on function public.agency_daily_totals(uuid, date, date) to service_role;
