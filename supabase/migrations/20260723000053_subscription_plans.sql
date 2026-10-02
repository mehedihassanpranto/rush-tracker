-- ============================================================================
-- Subscriptions v1: plans with usage limits, and a ledger of what each agency
-- has paid the platform.
--
-- * subscription_plans — name, monthly fee (BDT) and three limits: active
--   clients, ad accounts (owned + granted), active staff logins. A NULL limit
--   means unlimited. Plans are platform data, not tenant data.
-- * organizations.plan_id — which plan an agency is on. NULL = no plan
--   assigned yet, which the app treats as "no limits" so existing agencies are
--   never blocked by this migration. The legacy free-text organizations.plan
--   column is left alone.
-- * subscription_payments — append-only record of payments an agency made to
--   the platform, each covering a period. "Paid through" is derived (latest
--   period_end), never stored, matching how client dues are derived from the
--   ledger. Corrections are new rows, not edits (same ethos as adjustments).
--
-- Both tables: RLS enabled with ZERO policies — like `organizations` and
-- `app_settings`, they are reachable only through the service-role server
-- layer (platform fns are requirePlatformAdmin; the agency's own read-only
-- view goes through requireAdmin). Writes were already revoked from
-- anon/authenticated by default privileges (migration 000052).
--
-- subscription_payments.organization_id cascades on delete so offboarding an
-- agency (deleteOrganizationFn) removes its billing history with it instead
-- of failing on the foreign key. Nothing else references these tables.
-- ============================================================================

create table public.subscription_plans (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  monthly_fee_bdt  numeric(18, 2) not null default 0 check (monthly_fee_bdt >= 0),
  max_clients      integer check (max_clients is null or max_clients >= 0),
  max_ad_accounts  integer check (max_ad_accounts is null or max_ad_accounts >= 0),
  max_staff        integer check (max_staff is null or max_staff >= 0),
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.subscription_plans enable row level security;

alter table public.organizations
  add column plan_id uuid references public.subscription_plans (id);

create index idx_organizations_plan on public.organizations (plan_id);

create table public.subscription_payments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  plan_id          uuid references public.subscription_plans (id),
  amount_bdt       numeric(18, 2) not null check (amount_bdt > 0),
  period_start     date not null,
  period_end       date not null,
  paid_at          timestamptz not null default now(),
  method           text,
  reference        text,
  note             text,
  recorded_by      uuid references auth.users (id),
  created_at       timestamptz not null default now(),
  constraint subscription_payments_period_ck check (period_end >= period_start)
);

alter table public.subscription_payments enable row level security;

create index idx_subscription_payments_org
  on public.subscription_payments (organization_id, period_end desc);

-- Starting plans (owner-approved 2026-10-02). Prices/limits are editable from
-- Platform → Plans; these are only the initial values.
insert into public.subscription_plans
  (name, monthly_fee_bdt, max_clients, max_ad_accounts, max_staff, sort_order)
values
  ('Basic',      1500,   5,   15,    2, 1),
  ('Standard',   4000,  20,   60,    5, 2),
  ('Advance',    8000,  60,  200,   15, 3),
  ('Unlimited', 15000, null, null, null, 4);

-- billing_exempt: an agency that uses its plan without paying (the
-- deployment's own agency, or a deliberate free account). It is never shown as
-- unpaid/overdue; limits still apply. A flag rather than a check against org
-- zero's id in code, so the exemption is visible and changeable as data.
alter table public.organizations
  add column billing_exempt boolean not null default false;

-- xRush Agency (org zero, the deployment's own agency): Unlimited, free.
update public.organizations
   set plan_id = (select id from public.subscription_plans where name = 'Unlimited'),
       billing_exempt = true
 where id = '00000000-0000-0000-0000-000000000001';
