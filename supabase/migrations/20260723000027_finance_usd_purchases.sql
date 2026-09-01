-- ============================================================================
-- Rush Tracker — Finance: USD purchase ledger + weighted-average cost basis.
--
-- Refines the margin-tracking layer added in
-- 20260723000026_finance_usd_margin.sql — that migration's tables are
-- UNCHANGED here (still additive, still no touch to ledger_entries/payments/
-- limit_requests/Meta logic). The gap being closed: usd_margin_entries.buy_rate
-- was previously typed in blind, with no record of what USD was actually
-- bought for. This adds the buy side as its own append-only ledger, so
-- buy_rate can be sourced from real weighted-average cost instead of guessed.
--
-- Deliberately NOT a hard inventory constraint: usd_margin_entries can still
-- record a sale that exceeds what usd_purchases shows as available (real
-- purchase timing sometimes lags a sale by hours/days) — the UI surfaces
-- available inventory as a warning, not a database-enforced block. Revisit
-- if the owner wants it enforced.
-- ============================================================================

create table public.usd_purchases (
  id             uuid primary key default gen_random_uuid(),
  purchase_date  date not null,
  usd_amount     numeric(12, 2) not null check (usd_amount > 0),
  buy_rate       numeric(10, 4) not null check (buy_rate > 0),
  cost_bdt       numeric(12, 2) generated always as (round(usd_amount * buy_rate, 2)) stored,
  source         text,
  note           text,
  created_by     uuid references public.employees (id),
  created_at     timestamptz not null default now()
);

create index idx_usd_purchases_date on public.usd_purchases (purchase_date);

-- ----------------------------------------------------------------------------
-- Live inventory summary: total bought, total sold (via usd_margin_entries),
-- what's still available, and the weighted-average cost of every dollar ever
-- bought. Read-only aggregate, same pattern as client_financials().
-- ----------------------------------------------------------------------------
create or replace function public.usd_inventory_summary()
returns table (
  total_purchased_usd    numeric,
  total_purchased_cost_bdt numeric,
  weighted_avg_buy_rate  numeric,
  total_sold_usd         numeric,
  available_usd          numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(p.total_usd, 0),
    coalesce(p.total_cost, 0),
    case when coalesce(p.total_usd, 0) > 0
      then round(p.total_cost / p.total_usd, 4)
      else 0
    end,
    coalesce(s.total_usd, 0),
    coalesce(p.total_usd, 0) - coalesce(s.total_usd, 0)
  from
    (select sum(usd_amount) as total_usd, sum(cost_bdt) as total_cost
       from public.usd_purchases) p,
    (select sum(usd_amount) as total_usd
       from public.usd_margin_entries) s;
$$;

revoke all on function public.usd_inventory_summary() from public;
grant execute on function public.usd_inventory_summary() to service_role;

-- ----------------------------------------------------------------------------
-- Row Level Security — same convention as every finance table: SELECT-only
-- for authenticated, gated on the existing finance.view permission (no new
-- permission needed); writes go through the server layer.
-- ----------------------------------------------------------------------------
alter table public.usd_purchases enable row level security;

create policy usd_purchases_select on public.usd_purchases
  for select to authenticated
  using (public.is_admin() and public.has_permission('finance.view'));
