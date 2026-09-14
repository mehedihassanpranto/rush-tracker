-- ============================================================================
-- Rush Tracker — Multi-tenant conversion, Phase 1: schema + RLS foundation.
--
-- Rush Tracker is becoming a subscription product sold to other agencies.
-- This migration adds the `organizations` table, tags every agency-scoped
-- table with organization_id, adds a platform-level (cross-org) admin flag,
-- and updates every existing RLS SELECT policy to require an organization
-- match + active subscription, with a platform-admin bypass.
--
-- IMPORTANT — read this before assuming RLS alone isolates tenants:
-- RLS in this app is defense-in-depth only, not the primary authorization
-- layer. Per CLAUDE.md's documented security rules, virtually all business
-- reads/writes go through TanStack Start server functions using the
-- service-role key (getSupabaseAdminClient()), which BYPASSES RLS entirely.
-- This migration alone does NOT isolate two simultaneously-ACTIVE
-- organizations in the running app — every read/write inside
-- src/server/**/*.fns.ts (23 files) still needs to filter/tag
-- organization_id explicitly. That is the next, separate piece of this
-- conversion (tracked in CLAUDE.md as "server-layer org scoping"). This
-- migration is the schema/RLS half only.
--
-- organization_id defaults to org zero's id (a fixed literal, not a
-- subquery — Postgres doesn't allow subqueries in DEFAULT expressions) so
-- every existing insert path across the current server-fn code, none of
-- which sets organization_id yet, keeps working unchanged. This default is
-- a temporary safety net: remove it once the server-layer scoping pass
-- makes every insert explicit, otherwise a second org's write that forgets
-- to set organization_id would silently land in org zero's data.
--
-- Naming: the platform-wide flag is `is_platform_admin`, deliberately NOT
-- named `is_super_admin` — this app already has a per-organization
-- `SUPER_ADMIN` role (public.roles.key, checked by is_admin()/
-- has_permission()). That role stays subject to its own org's subscription
-- gate; is_platform_admin is a different, cross-org concept (bypasses the
-- gate entirely, sees every organization). Reusing the SUPER_ADMIN name for
-- both would risk a role-key check being mistaken for the platform-admin
-- check, or vice versa — kept deliberately distinct.
--
-- Manual rollback (Supabase's migration tooling has no automatic down-
-- migration mechanism, and none of the prior 30 migrations in this repo use
-- one — this comment is the documented reverse path instead):
--   alter policy user_profiles_select on public.user_profiles using (user_id = (select auth.uid()) or public.is_admin());
--   alter policy client_memberships_select on public.client_memberships using (user_id = (select auth.uid()) or public.is_admin());
--   alter policy clients_select on public.clients using (public.is_admin() or public.is_client_member(id));
--   alter policy audit_logs_select on public.audit_logs using (public.has_permission('audit_logs.view'));
--   alter policy ad_accounts_select on public.ad_accounts using (public.is_admin() or exists (select 1 from public.ad_account_assignments a where a.ad_account_id = ad_accounts.id and a.status = 'ACTIVE' and public.is_client_member(a.client_id)));
--   alter policy assignments_select on public.ad_account_assignments using (public.is_admin() or public.is_client_member(client_id));
--   alter policy exchange_rates_select on public.exchange_rates using (public.is_admin());
--   alter policy limit_requests_select on public.limit_requests using (public.is_admin() or public.is_client_member(client_id));
--   alter policy ledger_select on public.ledger_entries using ((public.is_admin() and public.has_permission('ledger.view')) or public.is_client_member(client_id));
--   alter policy attachments_select on public.attachments using (public.is_admin());
--   alter policy payments_select on public.payments using (public.is_admin() or public.is_client_member(client_id));
--   alter policy payment_requests_select on public.payment_requests using (public.is_admin() or public.is_client_member(client_id));
--   alter policy adjustments_select on public.adjustments using (public.is_admin() and public.has_permission('adjustments.view'));
--   alter policy employees_select on public.employees using (public.is_admin());
--   alter policy client_employees_select on public.client_employees using (public.is_admin());
--   alter policy notifications_select on public.notifications using (user_id = (select auth.uid()));
--   alter policy usd_margin_entries_select on public.usd_margin_entries using (public.is_admin() and public.has_permission('finance.view'));
--   drop function if exists public.current_org_id();
--   drop function if exists public.is_org_active(uuid);
--   drop function if exists public.is_platform_admin();
--   alter table public.user_profiles drop column is_platform_admin, drop column organization_id;
--   alter table public.<every other table above> drop column organization_id;  -- repeat per table
--   drop table public.organizations;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- organizations
-- ----------------------------------------------------------------------------
create table public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  subscription_status text not null default 'active'
                        check (subscription_status in ('active', 'suspended', 'cancelled')),
  plan                text,
  notes               text,
  suspended_at        timestamptz,
  created_at          timestamptz not null default now()
);

-- Org zero: this agency's own row, seeded with a fixed id so it can be used
-- as a literal DEFAULT below (see note above on why not a subquery).
insert into public.organizations (id, name, subscription_status) values
  ('00000000-0000-0000-0000-000000000001', 'xRush Agency', 'active');

-- ----------------------------------------------------------------------------
-- organization_id — added to every agency-scoped table plus user_profiles.
-- Each ADD COLUMN both backfills existing rows AND enforces NOT NULL in one
-- step (safe/fast: a constant DEFAULT is a metadata-only change in Postgres
-- 11+, no table rewrite).
-- ----------------------------------------------------------------------------
alter table public.user_profiles
  add column organization_id uuid not null
    default '00000000-0000-0000-0000-000000000001'
    references public.organizations (id),
  add column is_platform_admin boolean not null default false;
create index idx_user_profiles_organization on public.user_profiles (organization_id);

alter table public.clients add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_clients_organization on public.clients (organization_id);

alter table public.client_memberships add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_client_memberships_organization on public.client_memberships (organization_id);

alter table public.ad_accounts add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_ad_accounts_organization on public.ad_accounts (organization_id);

alter table public.ad_account_assignments add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_ad_account_assignments_organization on public.ad_account_assignments (organization_id);

alter table public.limit_requests add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_limit_requests_organization on public.limit_requests (organization_id);

alter table public.ledger_entries add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_ledger_entries_organization on public.ledger_entries (organization_id);

alter table public.attachments add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_attachments_organization on public.attachments (organization_id);

alter table public.payment_requests add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_payment_requests_organization on public.payment_requests (organization_id);

alter table public.payments add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_payments_organization on public.payments (organization_id);

alter table public.adjustments add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_adjustments_organization on public.adjustments (organization_id);

alter table public.exchange_rates add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_exchange_rates_organization on public.exchange_rates (organization_id);

alter table public.employees add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_employees_organization on public.employees (organization_id);

alter table public.client_employees add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_client_employees_organization on public.client_employees (organization_id);

alter table public.notifications add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_notifications_organization on public.notifications (organization_id);

alter table public.usd_margin_entries add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_usd_margin_entries_organization on public.usd_margin_entries (organization_id);

alter table public.audit_logs add column organization_id uuid not null
  default '00000000-0000-0000-0000-000000000001' references public.organizations (id);
create index idx_audit_logs_organization on public.audit_logs (organization_id);

-- NOTE: roles / permissions / role_permissions are deliberately NOT scoped —
-- they're shared structural taxonomy (role/permission keys), not per-agency
-- data. Per-org custom roles would be a much larger, unrequested feature.
-- user_permissions (per-user grants) is also left unscoped: its org is
-- derivable via user_profiles.user_id, and its existing RLS policy already
-- restricts to the owning user or an admin — adding organization_id there
-- would be redundant defense-in-depth, not a real gap.

-- ----------------------------------------------------------------------------
-- RLS helper functions (SECURITY DEFINER, matching the existing
-- is_admin()/is_client_member()/has_permission() style exactly).
-- ----------------------------------------------------------------------------
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select up.organization_id
  from public.user_profiles up
  where up.user_id = auth.uid();
$$;

create or replace function public.is_org_active(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select o.subscription_status = 'active' from public.organizations o where o.id = org_id),
    false
  );
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select up.is_platform_admin from public.user_profiles up where up.user_id = auth.uid()),
    false
  );
$$;

-- ----------------------------------------------------------------------------
-- Grant platform-admin access to the specified account.
-- ----------------------------------------------------------------------------
update public.user_profiles
set is_platform_admin = true
where user_id = (select id from auth.users where email = 'mehedi.h.prantoz@gmail.com');

-- ----------------------------------------------------------------------------
-- organizations RLS: zero policies for `authenticated`, same treatment as
-- app_settings — this table holds every customer's subscription status and
-- notes, cross-tenant by nature, so it must only ever be reachable through
-- the service-role server layer (the super-admin panel's server fns), never
-- queried directly from a signed-in browser session, not even an org's own
-- admin.
-- ----------------------------------------------------------------------------
alter table public.organizations enable row level security;

-- ----------------------------------------------------------------------------
-- Update every existing SELECT policy on the 16 agency-scoped tables (plus
-- user_profiles/clients/client_memberships/audit_logs already covered
-- above): wrap the existing condition with an organization match + active
-- subscription requirement, with a platform-admin bypass. Uses ALTER POLICY
-- to preserve each policy's name/history rather than drop+recreate.
-- ----------------------------------------------------------------------------
alter policy user_profiles_select on public.user_profiles
  using (
    (
      (user_id = (select auth.uid()) or public.is_admin())
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy client_memberships_select on public.client_memberships
  using (
    (
      (user_id = (select auth.uid()) or public.is_admin())
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy clients_select on public.clients
  using (
    (
      (public.is_admin() or public.is_client_member(id))
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy audit_logs_select on public.audit_logs
  using (
    (
      public.has_permission('audit_logs.view')
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy ad_accounts_select on public.ad_accounts
  using (
    (
      (
        public.is_admin()
        or exists (
          select 1 from public.ad_account_assignments a
          where a.ad_account_id = ad_accounts.id
            and a.status = 'ACTIVE'
            and public.is_client_member(a.client_id)
        )
      )
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy assignments_select on public.ad_account_assignments
  using (
    (
      (public.is_admin() or public.is_client_member(client_id))
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy exchange_rates_select on public.exchange_rates
  using (
    (
      public.is_admin()
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy limit_requests_select on public.limit_requests
  using (
    (
      (public.is_admin() or public.is_client_member(client_id))
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy ledger_select on public.ledger_entries
  using (
    (
      (
        (public.is_admin() and public.has_permission('ledger.view'))
        or public.is_client_member(client_id)
      )
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy attachments_select on public.attachments
  using (
    (
      public.is_admin()
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy payments_select on public.payments
  using (
    (
      (public.is_admin() or public.is_client_member(client_id))
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy payment_requests_select on public.payment_requests
  using (
    (
      (public.is_admin() or public.is_client_member(client_id))
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy adjustments_select on public.adjustments
  using (
    (
      (public.is_admin() and public.has_permission('adjustments.view'))
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy employees_select on public.employees
  using (
    (
      public.is_admin()
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy client_employees_select on public.client_employees
  using (
    (
      public.is_admin()
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy notifications_select on public.notifications
  using (
    (
      user_id = (select auth.uid())
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

alter policy usd_margin_entries_select on public.usd_margin_entries
  using (
    (
      (public.is_admin() and public.has_permission('finance.view'))
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );
