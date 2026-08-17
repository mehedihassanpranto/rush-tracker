-- ============================================================================
-- Rush Tracker — Employees (agency staff assigned to service clients).
--
-- Post-Phase-8 addition. A separate concept from client_memberships (which
-- are CLIENT-role portal logins, i.e. the client's own team, self-managed
-- from the portal — see the "Team members" feature, which reuses
-- client_memberships/user_profiles and needs no new table).
--
-- employees are agency-side staff (e.g. account managers); client_employees
-- is a plain many-to-many assignment of which employees currently service
-- which clients. Admin-managed only.
-- ============================================================================

create type public.employee_status as enum ('ACTIVE', 'INACTIVE');

-- ----------------------------------------------------------------------------
-- Human-readable code sequence (same pattern as client_code/account_code).
-- ----------------------------------------------------------------------------
create sequence if not exists public.employee_code_seq;

create table public.employees (
  id           uuid primary key default gen_random_uuid(),
  employee_code text not null unique
                 default ('EMP-' || lpad(nextval('public.employee_code_seq')::text, 4, '0')),
  name         text not null,
  email        text,
  status       public.employee_status not null default 'ACTIVE',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Client <-> Employee assignment (many-to-many — an employee can serve
-- multiple clients, a client can have multiple employees). Plain junction,
-- no history/status tracking (not asked for; add later if needed).
-- ----------------------------------------------------------------------------
create table public.client_employees (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id),
  employee_id uuid not null references public.employees (id),
  assigned_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (client_id, employee_id)
);

create index idx_employees_status on public.employees (status);
create index idx_client_employees_client on public.client_employees (client_id);
create index idx_client_employees_employee on public.client_employees (employee_id);

create trigger trg_employees_updated_at
  before update on public.employees
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Row Level Security (SELECT-only for browser; writes go through the server).
-- Admin-only data — no client-facing read policy, matching this being an
-- internal agency-staffing concept the client portal never sees.
-- ----------------------------------------------------------------------------
alter table public.employees enable row level security;
alter table public.client_employees enable row level security;

create policy employees_select on public.employees
  for select to authenticated
  using (public.is_admin());

create policy client_employees_select on public.client_employees
  for select to authenticated
  using (public.is_admin());

-- ----------------------------------------------------------------------------
-- Permissions (spec §8 pattern) — default ADMIN grant, not sensitive.
-- ----------------------------------------------------------------------------
insert into public.permissions (key, description) values
  ('employees.view', 'View employees'),
  ('employees.manage', 'Create/edit/assign employees');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in ('employees.view', 'employees.manage')
where r.key = 'ADMIN';
