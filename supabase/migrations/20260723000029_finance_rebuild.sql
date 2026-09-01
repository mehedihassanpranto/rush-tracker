-- ============================================================================
-- Rush Tracker — Finance rebuild.
--
-- Replaces the whole first pass (20260723000026/027/028) with a simpler
-- model per the owner's direction: one row per USD transaction — USD
-- amount, what was paid for it (buying amount), what it was sold for
-- (selling amount) — margin is just selling minus buying, no rates, no
-- separate purchase/inventory ledger, no per-client sell-rate history.
--
-- Safe to drop and recreate: every table here was confirmed to hold only
-- the owner's own test rows (one row each, matching the exact test values
-- shown while trying out the old design), not real production data.
--
-- client_usd_rates and usd_purchases (+ usd_inventory_summary()) are
-- dropped outright — not needed under the new model. usd_margin_entries is
-- dropped and recreated with the new column shape (client_id,
-- ledger_entry_id, buy_rate, sell_rate are gone; buying_amount_bdt /
-- selling_amount_bdt replace them). finance.view / finance.manage
-- permissions are unchanged and still gate everything here.
-- ============================================================================

drop function if exists public.usd_inventory_summary();
drop table if exists public.usd_purchases;
drop table if exists public.client_usd_rates;
drop table if exists public.usd_margin_entries;

create table public.usd_margin_entries (
  id                 uuid primary key default gen_random_uuid(),
  transaction_date   date not null,
  usd_amount         numeric(12, 2) not null check (usd_amount > 0),
  buying_amount_bdt  numeric(12, 2) not null check (buying_amount_bdt > 0),
  selling_amount_bdt numeric(12, 2) not null check (selling_amount_bdt > 0),
  margin_bdt         numeric(12, 2)
                        generated always as (selling_amount_bdt - buying_amount_bdt) stored,
  created_at         timestamptz not null default now()
);

create index idx_usd_margin_entries_date on public.usd_margin_entries (transaction_date);

alter table public.usd_margin_entries enable row level security;

create policy usd_margin_entries_select on public.usd_margin_entries
  for select to authenticated
  using (public.is_admin() and public.has_permission('finance.view'));
