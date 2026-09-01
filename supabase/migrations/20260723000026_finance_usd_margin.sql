-- ============================================================================
-- Rush Tracker — Finance: USD buy/sell margin tracking (forex spread revenue).
--
-- Purely additive. Does NOT touch ledger_entries, payments, limit_requests,
-- or any Meta spend-cap logic — this is a new, parallel bookkeeping layer for
-- the agency's OWN cost side of buying USD, alongside the sell side the app
-- already bills clients for.
--
-- Schema note (flagged per owner request, before this ran):
--   ledger_entries.usd_rate is the closest existing analog to a "sell rate" —
--   it's the rate CHARGED TO THE CLIENT, snapshotted at limit-approval time
--   from limit_requests.approved_usd_rate (see approve_limit_request() in
--   20260723000003_phase3_limits.sql). There is no "buy rate" (what the
--   agency itself pays to acquire USD) anywhere in the existing schema —
--   that side of the transaction has never been tracked. usd_margin_entries
--   below is the first place it exists; buy_rate has no existing source to
--   derive from and will need to be entered by hand (or wired to a future
--   buy-side feed) once backend logic is built in a later step.
--
--   Also flagged: clients.usd_rate (20260723000009_client_usd_rate.sql) is
--   the LIVE, single scalar "current sell rate for this client" already used
--   for real billing (rate.service.ts's adAccountUsdRate(), falling back
--   from ad_accounts.usd_rate). client_usd_rates below is a NEW, separate,
--   time-sliced history of sell rates for margin reporting — it does not
--   read from or write to clients.usd_rate, and nothing keeps the two in
--   sync automatically. That wiring (if wanted) is backend-logic work for a
--   later step, not this migration; until then, treat clients.usd_rate as
--   the source of truth for billing and client_usd_rates as a separate
--   margin-tracking ledger that a future admin UI will need to populate
--   deliberately.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Per-client sell-rate history (margin tracking only — see note above).
-- ----------------------------------------------------------------------------
create table public.client_usd_rates (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id),
  sell_rate       numeric(10, 4) not null check (sell_rate > 0),
  effective_from  date not null,
  effective_to    date,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.employees (id),
  check (effective_to is null or effective_to >= effective_from)
);

create index idx_client_usd_rates_client_effective
  on public.client_usd_rates (client_id, effective_from);

-- ----------------------------------------------------------------------------
-- Per-transaction USD buy/sell margin (the spread revenue itself).
-- ----------------------------------------------------------------------------
create table public.usd_margin_entries (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id),
  ledger_entry_id  uuid references public.ledger_entries (id),
  usd_amount       numeric(12, 2) not null check (usd_amount > 0),
  buy_rate         numeric(10, 4) not null check (buy_rate > 0),
  sell_rate        numeric(10, 4) not null check (sell_rate > 0),
  margin_bdt       numeric(12, 2)
                     generated always as (round(usd_amount * (sell_rate - buy_rate), 2)) stored,
  transaction_date date not null,
  created_at       timestamptz not null default now()
);

create index idx_usd_margin_entries_client_date
  on public.usd_margin_entries (client_id, transaction_date);

-- ----------------------------------------------------------------------------
-- Row Level Security (SELECT-only for authenticated; no write policies —
-- writes will go through the server layer with the service-role key, same
-- convention as every other table). New sensitive permission: profit-margin
-- data is more sensitive than typical admin data (it's the agency's own
-- cost/profit, not just client billing), so it gets the same treatment as
-- adjustments.create / exchange_rate.manage / users.manage / integrations.manage
-- — SUPER_ADMIN only by default, NOT granted to ADMIN's role_permissions.
-- An ADMIN can still be granted it individually later via the existing Users
-- screen (user_permissions), same as those other sensitive permissions.
-- ----------------------------------------------------------------------------
alter table public.client_usd_rates enable row level security;
alter table public.usd_margin_entries enable row level security;

create policy client_usd_rates_select on public.client_usd_rates
  for select to authenticated
  using (public.is_admin() and public.has_permission('finance.view'));

create policy usd_margin_entries_select on public.usd_margin_entries
  for select to authenticated
  using (public.is_admin() and public.has_permission('finance.view'));

insert into public.permissions (key, description) values
  ('finance.view', 'View USD buy/sell margin data (sensitive)'),
  ('finance.manage', 'Record USD rates and margin entries (sensitive)');
