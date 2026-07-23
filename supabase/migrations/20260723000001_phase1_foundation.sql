-- ============================================================================
-- Rush Tracker — Phase 1 Foundation
-- Roles / permissions (RBAC), user profiles, clients, client memberships,
-- audit logs, helper functions, new-user trigger, RLS.
--
-- Security model (spec §5, §59, §60):
--   * All business mutations happen through TanStack Start server functions.
--   * The browser (anon/authenticated) gets READ-ONLY access to its own rows.
--   * No INSERT/UPDATE/DELETE policies exist for `authenticated` — writes are
--     performed with the service-role key server-side (bypasses RLS) after
--     application-level authorization.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type public.user_status as enum ('ACTIVE', 'INACTIVE', 'SUSPENDED');
create type public.client_status as enum ('ACTIVE', 'INACTIVE', 'SUSPENDED');
create type public.membership_status as enum ('ACTIVE', 'INACTIVE');

-- ----------------------------------------------------------------------------
-- RBAC: roles, permissions, role_permissions, user_permissions
-- ----------------------------------------------------------------------------
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  description text,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  description text,
  created_at  timestamptz not null default now()
);

create table public.role_permissions (
  role_id       uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

-- ----------------------------------------------------------------------------
-- User profiles (1:1 with auth.users)
-- ----------------------------------------------------------------------------
create table public.user_profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '',
  role_id    uuid not null references public.roles (id),
  status     public.user_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Per-user permission grants on top of role defaults (for ADMIN users).
create table public.user_permissions (
  user_id       uuid not null references public.user_profiles (user_id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  granted_by    uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  primary key (user_id, permission_id)
);

-- ----------------------------------------------------------------------------
-- Clients + memberships
-- ----------------------------------------------------------------------------
create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  client_code  text not null unique,
  name         text not null,
  company_name text,
  email        text,
  phone        text,
  address      text,
  status       public.client_status not null default 'ACTIVE',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.client_memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.user_profiles (user_id) on delete cascade,
  client_id  uuid not null references public.clients (id) on delete cascade,
  status     public.membership_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);

-- ----------------------------------------------------------------------------
-- Audit logs (append-only)
-- ----------------------------------------------------------------------------
create table public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users (id),
  action        text not null,
  entity_type   text not null,
  entity_id     text,
  old_values    jsonb,
  new_values    jsonb,
  metadata      jsonb,
  created_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
create index idx_user_profiles_role on public.user_profiles (role_id);
create index idx_client_memberships_user on public.client_memberships (user_id);
create index idx_client_memberships_client on public.client_memberships (client_id);
create index idx_client_memberships_status on public.client_memberships (status);
create index idx_audit_logs_entity on public.audit_logs (entity_type, entity_id);
create index idx_audit_logs_created_at on public.audit_logs (created_at);
create index idx_audit_logs_actor on public.audit_logs (actor_user_id);

-- ----------------------------------------------------------------------------
-- updated_at trigger
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

create trigger trg_clients_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Auth helper functions (SECURITY DEFINER so RLS policies can use them
-- without recursive policy evaluation).
-- ----------------------------------------------------------------------------
create or replace function public.current_role_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.key
  from public.user_profiles up
  join public.roles r on r.id = up.role_id
  where up.user_id = auth.uid()
    and up.status = 'ACTIVE';
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role_key() in ('ADMIN', 'SUPER_ADMIN'), false);
$$;

create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_role_key() = 'SUPER_ADMIN' then true
    when public.current_role_key() = 'ADMIN' then exists (
      select 1
      from public.user_profiles up
      join public.role_permissions rp on rp.role_id = up.role_id
      join public.permissions p on p.id = rp.permission_id
      where up.user_id = auth.uid() and p.key = perm
      union
      select 1
      from public.user_permissions upr
      join public.permissions p2 on p2.id = upr.permission_id
      where upr.user_id = auth.uid() and p2.key = perm
    )
    else false
  end;
$$;

create or replace function public.is_client_member(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.client_memberships cm
    where cm.user_id = auth.uid()
      and cm.client_id = cid
      and cm.status = 'ACTIVE'
  );
$$;

-- ----------------------------------------------------------------------------
-- New-user trigger: create a profile for every new auth user.
--
-- Role comes from raw_app_meta_data ->> 'app_role' (app_metadata), which can
-- ONLY be set with the service-role key (admin provisioning). Self-signups
-- cannot set app_metadata, so they always default to CLIENT — a user can
-- never escalate their own role via signup metadata.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role_key text;
  v_role_id uuid;
begin
  v_role_key := coalesce(new.raw_app_meta_data ->> 'app_role', 'CLIENT');
  if v_role_key not in ('SUPER_ADMIN', 'ADMIN', 'CLIENT') then
    v_role_key := 'CLIENT';
  end if;

  select id into v_role_id from public.roles where key = v_role_key;

  insert into public.user_profiles (user_id, full_name, role_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    v_role_id
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_profiles enable row level security;
alter table public.user_permissions enable row level security;
alter table public.clients enable row level security;
alter table public.client_memberships enable row level security;
alter table public.audit_logs enable row level security;

-- RBAC reference data: readable by any authenticated user.
create policy roles_select on public.roles
  for select to authenticated using (true);

create policy permissions_select on public.permissions
  for select to authenticated using (true);

create policy role_permissions_select on public.role_permissions
  for select to authenticated using (true);

-- Profiles: own row, or any row for admins.
create policy user_profiles_select on public.user_profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Per-user grants: own rows, or any for admins.
create policy user_permissions_select on public.user_permissions
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Clients: admins see all; client users see only clients they belong to.
create policy clients_select on public.clients
  for select to authenticated
  using (public.is_admin() or public.is_client_member(id));

-- Memberships: own rows, or any for admins.
create policy client_memberships_select on public.client_memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Audit logs: admins with the audit_logs.view permission only.
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (public.has_permission('audit_logs.view'));

-- NOTE: intentionally NO insert/update/delete policies for `authenticated`.
-- All writes go through the server layer using the service-role key.

-- ----------------------------------------------------------------------------
-- Seed: system roles
-- ----------------------------------------------------------------------------
insert into public.roles (key, name, description, is_system) values
  ('SUPER_ADMIN', 'Super Admin', 'Full system access', true),
  ('ADMIN', 'Admin', 'Permission-based administrative access', true),
  ('CLIENT', 'Client', 'Client organization user', true);

-- ----------------------------------------------------------------------------
-- Seed: permissions (spec §8)
-- ----------------------------------------------------------------------------
insert into public.permissions (key, description) values
  ('dashboard.view', 'View admin dashboard'),
  ('clients.view', 'View clients'),
  ('clients.manage', 'Create/edit/deactivate clients'),
  ('ad_accounts.view', 'View ad accounts'),
  ('ad_accounts.manage', 'Create/edit/rename/status ad accounts'),
  ('ad_accounts.assign', 'Assign/release ad accounts'),
  ('ad_accounts.transfer', 'Transfer ad accounts between clients'),
  ('limit_requests.view', 'View limit requests'),
  ('limit_requests.approve', 'Approve/reject limit requests'),
  ('payments.view', 'View payments'),
  ('payments.approve', 'Approve/reject payments'),
  ('payment_requests.create', 'Create payment requests'),
  ('ledger.view', 'View financial ledger'),
  ('adjustments.view', 'View adjustments'),
  ('adjustments.create', 'Create adjustments/reversals (sensitive)'),
  ('reports.view', 'View reports'),
  ('exchange_rate.manage', 'Manage default USD rate (sensitive)'),
  ('users.view', 'View users'),
  ('users.manage', 'Manage users/roles/permissions (sensitive)'),
  ('audit_logs.view', 'View audit logs');

-- ----------------------------------------------------------------------------
-- Seed: default ADMIN role permissions.
-- Sensitive permissions (adjustments.create, exchange_rate.manage,
-- users.manage) are intentionally excluded — grant per-user via
-- user_permissions.
-- ----------------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in (
  'dashboard.view',
  'clients.view',
  'clients.manage',
  'ad_accounts.view',
  'ad_accounts.manage',
  'ad_accounts.assign',
  'ad_accounts.transfer',
  'limit_requests.view',
  'limit_requests.approve',
  'payments.view',
  'payments.approve',
  'payment_requests.create',
  'ledger.view',
  'adjustments.view',
  'reports.view',
  'users.view',
  'audit_logs.view'
)
where r.key = 'ADMIN';
