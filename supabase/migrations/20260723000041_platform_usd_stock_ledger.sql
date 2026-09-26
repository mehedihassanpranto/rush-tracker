-- ============================================================================
-- Rush Tracker — the PLATFORM's USD/BDT stock ledger (spec §6.1–6.5 of the
-- "Mother Platform Account Control & Finance Dashboard" doc).
--
-- The platform buys USD from sources (S1, S2, ...) paying BDT, and sells USD /
-- limit to agencies receiving BDT. Three tables record that, two views derive
-- the stock position and each agency's totals from them.
--
-- THIS IS NOT THE AGENCY'S FINANCE PAGE. `usd_margin_entries` (migration
-- 000030, /agency/finance) is one AGENCY's own forex spread against ITS
-- clients. These tables are the platform's inventory accounting one level up:
-- what the platform paid for its dollars and what it charged agencies. The two
-- share no rows and no columns; `usd_purchases` used to exist as an agency-side
-- table and was dropped in migration 000029 — this is a different table that
-- happens to reuse the name, with no organization_id and no relation to it.
--
-- SECURITY — the boundary that matters most (spec §6.5): buying rates, source
-- names and BDT cost are the platform's margin. An agency must never be able
-- to read them. Three layers, deliberately redundant:
--   1. RLS is enabled on all three tables with ZERO policies (same treatment
--      as platform_settings / app_settings), so `authenticated` reads nothing.
--   2. Every grant to anon/authenticated is REVOKED outright. Supabase grants
--      new public objects to those roles by default, and RLS alone is a single
--      layer that a later `create policy` could quietly undo.
--   3. The views are `security_invoker`. A default view runs with its OWNER's
--      rights, which bypass RLS — and views in `public` are exposed through
--      PostgREST, so without this an aggregate over these tables would be
--      readable with the public anon key. That is the classic way a table
--      that "has RLS" still leaks.
-- The only access path is the service-role server layer behind
-- requirePlatformAdmin().
--
-- SURVIVING AN AGENCY'S DELETION: usd_sales.organization_id is ON DELETE SET
-- NULL, not the RESTRICT/NO ACTION every other tenant table uses. A sale is
-- the PLATFORM's revenue; deleting a departed customer must not erase it,
-- because total_usd_sold feeds remaining stock and the gross difference —
-- dropping the row would silently put phantom dollars back into stock. The
-- agency's name is therefore snapshotted at sale time (`agency_name`) so a
-- surviving row still says who bought. ad_account_id is SET NULL for the same
-- reason (and so an agency's "Clear all data" / offboarding is never blocked).
--
-- Money units: usd_amount is dollars, bdt_amount is taka, both major units.
-- Rates are never entered — always bdt_amount / usd_amount per transaction,
-- because every purchase and sale can carry a different one.
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   drop view public.agency_usd_summary;
--   drop view public.usd_stock_summary;
--   drop table public.usd_sales;
--   drop table public.usd_purchases;
--   drop table public.usd_sources;
--   drop sequence public.usd_sale_seq;
-- ============================================================================

create sequence if not exists public.usd_sale_seq;
-- ---------------------------------------------------------------- sources ---
create table public.usd_sources (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
-- Case-insensitive: "S1" and "s1" are the same source. Stricter than the
-- spec's plain UNIQUE, which would have allowed both.
create unique index uq_usd_sources_name on public.usd_sources (lower(name));
-- -------------------------------------------------------------- purchases ---
create table public.usd_purchases (
  id           uuid primary key default gen_random_uuid(),
  -- NO ACTION on purpose: a source with purchase history cannot be deleted.
  -- There is no delete path anyway — a source is deactivated instead.
  source_id    uuid not null references public.usd_sources (id),
  method       text,
  usd_amount   numeric(18, 2) not null check (usd_amount > 0),
  bdt_amount   numeric(18, 2) not null check (bdt_amount > 0),
  -- Plain numeric, not numeric(p,s): a very small usd_amount against a large
  -- bdt_amount must not overflow a fixed precision. Rounded for display; the
  -- summary views aggregate the amounts, never these per-row rates.
  buying_rate  numeric generated always as (round(bdt_amount / usd_amount, 4)) stored,
  purchased_at timestamptz not null default now(),
  recorded_by  uuid references auth.users (id),
  notes        text,
  created_at   timestamptz not null default now()
);
create index idx_usd_purchases_purchased_at on public.usd_purchases (purchased_at, created_at);
create index idx_usd_purchases_source on public.usd_purchases (source_id, purchased_at);
-- ------------------------------------------------------------------ sales ---
create table public.usd_sales (
  id              uuid primary key default gen_random_uuid(),
  -- NULL only ever results from the agency being deleted (see header); the
  -- server fn always sets it.
  organization_id uuid references public.organizations (id) on delete set null,
  agency_name     text not null,
  ad_account_id   uuid references public.ad_accounts (id) on delete set null,
  usd_amount      numeric(18, 2) not null check (usd_amount > 0),
  bdt_amount      numeric(18, 2) not null check (bdt_amount > 0),
  selling_rate    numeric generated always as (round(bdt_amount / usd_amount, 4)) stored,
  -- Human-facing transaction id, "USD-2026-00042". The year is the Asia/Dhaka
  -- business year (a sale at 11pm on 31 Dec UTC is already next year there);
  -- the counter is one running sequence, not reset each year.
  reference_id    text not null unique default (
    'USD-'
    || to_char(timezone('Asia/Dhaka', now()), 'YYYY')
    || '-'
    || lpad(nextval('public.usd_sale_seq')::text, 5, '0')
  ),
  sold_at         timestamptz not null default now(),
  recorded_by     uuid references auth.users (id),
  notes           text,
  created_at      timestamptz not null default now()
);
create index idx_usd_sales_org on public.usd_sales (organization_id, sold_at desc);
create index idx_usd_sales_sold_at on public.usd_sales (sold_at desc);
-- ---------------------------------------------------------------- access ---
alter table public.usd_sources   enable row level security;
alter table public.usd_purchases enable row level security;
alter table public.usd_sales     enable row level security;
-- Intentionally no policies — see SECURITY above.

revoke all on public.usd_sources, public.usd_purchases, public.usd_sales
  from anon, authenticated;
revoke all on sequence public.usd_sale_seq from anon, authenticated;
-- ------------------------------------------------------- stock position ---
-- Weighted-average costing (the spec's v1 recommendation, §6.2/§10):
--   remaining stock value  = remaining USD x average buying rate
--   gross BDT difference   = BDT received - (USD sold x average buying rate)
-- nullif() keeps a fresh platform with no purchases returning NULL rates
-- instead of a division-by-zero error; the dependent figures are NULL too
-- (cost is genuinely unknown until something has been bought).
create view public.usd_stock_summary
  with (security_invoker = true) as
with purchase_totals as (
  select
    coalesce(sum(usd_amount), 0) as total_usd_purchased,
    coalesce(sum(bdt_amount), 0) as total_bdt_invested
  from public.usd_purchases
),
sale_totals as (
  select
    coalesce(sum(usd_amount), 0) as total_usd_sold,
    coalesce(sum(bdt_amount), 0) as total_bdt_received
  from public.usd_sales
)
select
  p.total_usd_purchased,
  p.total_bdt_invested,
  s.total_usd_sold,
  s.total_bdt_received,
  p.total_usd_purchased - s.total_usd_sold as remaining_usd_stock,
  p.total_bdt_invested / nullif(p.total_usd_purchased, 0) as avg_buying_rate,
  s.total_bdt_received / nullif(s.total_usd_sold, 0) as avg_selling_rate,
  (p.total_usd_purchased - s.total_usd_sold)
    * (p.total_bdt_invested / nullif(p.total_usd_purchased, 0)) as remaining_stock_bdt_value,
  s.total_bdt_received
    - s.total_usd_sold * (p.total_bdt_invested / nullif(p.total_usd_purchased, 0)) as gross_bdt_difference
from purchase_totals p, sale_totals s;
-- --------------------------------------------------------- agency totals ---
-- One row per agency that has bought. Sales whose agency was since deleted
-- have a NULL organization_id and are grouped by their snapshotted name, so
-- two departed agencies are not merged into one anonymous line.
create view public.agency_usd_summary
  with (security_invoker = true) as
select
  organization_id,
  case when organization_id is null then agency_name end as removed_agency_name,
  sum(usd_amount)                                        as total_usd_allocated,
  sum(bdt_amount)                                        as total_bdt_paid,
  count(*)                                               as transaction_count,
  max(sold_at)                                           as last_transaction_at,
  sum(bdt_amount) / nullif(sum(usd_amount), 0)           as avg_selling_rate
from public.usd_sales
group by organization_id, case when organization_id is null then agency_name end;
revoke all on public.usd_stock_summary, public.agency_usd_summary from anon, authenticated;
comment on table public.usd_sources is
  'Where the platform buys USD (S1, S2, ...). Platform-internal; agencies never read it.';
comment on table public.usd_purchases is
  'Platform USD purchases: USD bought from a source for BDT. The platform''s cost basis — '
  'never exposed to an agency. Insert-only in v1.';
comment on table public.usd_sales is
  'Platform USD sales: USD/limit sold to an agency for BDT. organization_id survives as NULL '
  'if the agency is deleted; agency_name is the snapshot. Insert-only in v1.';
