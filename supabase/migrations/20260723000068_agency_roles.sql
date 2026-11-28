-- ============================================================================
-- Agency roles (owner request, 2026-11-28): each agency builds its own named
-- staff roles ("Accountant", "Support", ...) from the permission keys, and
-- every ADMIN login gets one. SUPER_ADMIN stays the system role with full
-- access; the system ADMIN role's defaults (role_permissions) and per-user
-- grants (user_permissions) remain only as the fallback for a login with no
-- agency role, so code that predates this keeps working against it.
--
--   agency_roles             one agency's roles. Names are unique per agency,
--                            case-insensitively.
--   agency_role_permissions  role → permission. organization_id rides along
--                            (and is checked by the composite FK) so a role
--                            can't be given rows tagged for another agency.
--   user_profiles.agency_role_id
--                            the login's role. The composite FK makes a role
--                            from another agency impossible to assign.
--
-- Every agency gets an "Admin" role holding the system ADMIN defaults (minus
-- the removed Employees feature's keys), and its ADMIN logins move onto it,
-- so nobody's access changes. A login with per-user grants keeps the old
-- path (no agency role) instead, since folding its extras into the shared
-- role would widen everyone else's access. New agencies get the same "Admin"
-- role from a trigger.
--
-- Unlike business data, roles go with their agency (ON DELETE CASCADE): they
-- hold no history, and offboarding deletes the agency's logins before the
-- organization row, so nothing still points at them by then.
--
-- RLS on, zero policies, grants revoked: read and written by the server layer
-- only (the session load reads them with the service role).
--
-- MANUAL ROLLBACK:
--   drop trigger organizations_seed_agency_roles on public.organizations;
--   drop function public.seed_default_agency_role();
--   alter table public.user_profiles drop column agency_role_id;
--   drop table public.agency_role_permissions;
--   drop table public.agency_roles;
-- ============================================================================

create table public.agency_roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 60),
  description     text check (description is null or char_length(description) <= 300),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index agency_roles_org_name_key
  on public.agency_roles (organization_id, lower(btrim(name)));

create table public.agency_role_permissions (
  role_id         uuid not null,
  permission_id   uuid not null references public.permissions (id) on delete cascade,
  organization_id uuid not null,
  primary key (role_id, permission_id),
  foreign key (role_id, organization_id)
    references public.agency_roles (id, organization_id) on delete cascade
);

alter table public.user_profiles add column agency_role_id uuid;
alter table public.user_profiles
  add constraint user_profiles_agency_role_fkey
  foreign key (agency_role_id, organization_id)
  references public.agency_roles (id, organization_id);
create index idx_user_profiles_agency_role on public.user_profiles (agency_role_id);

alter table public.agency_roles enable row level security;
alter table public.agency_role_permissions enable row level security;
revoke all on public.agency_roles from anon, authenticated;
revoke all on public.agency_role_permissions from anon, authenticated;

comment on table public.agency_roles is
  'An agency''s own staff roles, built from permission keys. ADMIN logins point at one via user_profiles.agency_role_id.';

-- The "Admin" role every agency starts with: the system ADMIN defaults.
create or replace function public.seed_default_agency_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role_id uuid;
begin
  insert into public.agency_roles (organization_id, name, description)
  values (new.id, 'Admin', 'Day-to-day admin: everything except sensitive permissions.')
  on conflict do nothing
  returning id into v_role_id;
  if v_role_id is null then
    return new;
  end if;

  insert into public.agency_role_permissions (role_id, permission_id, organization_id)
  select v_role_id, rp.permission_id, new.id
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id and r.key = 'ADMIN'
  join public.permissions p on p.id = rp.permission_id
  where p.key not like 'employees.%';
  return new;
end;
$$;

revoke execute on function public.seed_default_agency_role() from public, anon, authenticated;

create trigger organizations_seed_agency_roles
  after insert on public.organizations
  for each row execute function public.seed_default_agency_role();

-- Backfill existing agencies.
insert into public.agency_roles (organization_id, name, description)
select o.id, 'Admin', 'Day-to-day admin: everything except sensitive permissions.'
from public.organizations o
on conflict do nothing;

insert into public.agency_role_permissions (role_id, permission_id, organization_id)
select ar.id, rp.permission_id, ar.organization_id
from public.agency_roles ar
join public.roles r on r.key = 'ADMIN'
join public.role_permissions rp on rp.role_id = r.id
join public.permissions p on p.id = rp.permission_id
where ar.name = 'Admin'
  and p.key not like 'employees.%'
on conflict do nothing;

update public.user_profiles up
set agency_role_id = ar.id
from public.roles r, public.agency_roles ar
where r.id = up.role_id
  and r.key = 'ADMIN'
  and ar.organization_id = up.organization_id
  and ar.name = 'Admin'
  and up.agency_role_id is null
  and not exists (select 1 from public.user_permissions x where x.user_id = up.user_id);
