-- ============================================================================
-- Rush Tracker — usd_margin_entries: add buying_rate / selling_rate,
-- buying_amount_bdt / selling_amount_bdt become DB-computed from them.
--
-- Follow-up to 20260723000029_finance_rebuild.sql (confirmed applied live,
-- table confirmed empty — safe to drop and recreate again). Owner asked for
-- a rate field before each amount field, with the amount auto-calculated
-- rather than typed directly: buying_amount_bdt = usd_amount * buying_rate,
-- selling_amount_bdt = usd_amount * selling_rate.
--
-- Postgres can't convert a plain column into a generated one via ALTER, and
-- a generated column can't reference another generated column — so
-- margin_bdt is expressed directly from usd_amount/buying_rate/selling_rate,
-- not from the amount columns.
-- ============================================================================

drop table if exists public.usd_margin_entries;

create table public.usd_margin_entries (
  id                 uuid primary key default gen_random_uuid(),
  transaction_date   date not null,
  usd_amount         numeric(12, 2) not null check (usd_amount > 0),
  buying_rate        numeric(10, 4) not null check (buying_rate > 0),
  buying_amount_bdt  numeric(12, 2)
                        generated always as (round(usd_amount * buying_rate, 2)) stored,
  selling_rate       numeric(10, 4) not null check (selling_rate > 0),
  selling_amount_bdt numeric(12, 2)
                        generated always as (round(usd_amount * selling_rate, 2)) stored,
  margin_bdt         numeric(12, 2)
                        generated always as (round(usd_amount * (selling_rate - buying_rate), 2)) stored,
  created_at         timestamptz not null default now()
);

create index idx_usd_margin_entries_date on public.usd_margin_entries (transaction_date);

alter table public.usd_margin_entries enable row level security;

create policy usd_margin_entries_select on public.usd_margin_entries
  for select to authenticated
  using (public.is_admin() and public.has_permission('finance.view'));
