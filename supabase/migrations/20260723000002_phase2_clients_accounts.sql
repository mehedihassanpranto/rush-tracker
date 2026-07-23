-- ============================================================================
-- Rush Tracker — Phase 2: Ad Accounts, Assignments, human-readable codes,
-- atomic assign/release/transfer RPCs, RLS.
--
-- Financial note: assignment opening/closing limits are OPERATIONAL USD only.
-- They never create client due — billing arrives with approved limit requests
-- in Phase 3/4 (spec §15, §16, Rule 5).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type public.ad_account_status as enum (
  'AVAILABLE', 'ACTIVE', 'INACTIVE', 'SUSPENDED'
);
create type public.assignment_status as enum ('ACTIVE', 'RELEASED');

-- ----------------------------------------------------------------------------
-- Human-readable code sequences (internal id stays UUID; codes are display).
-- Seed each sequence past any codes that already exist so we never collide
-- with rows created by the dev seed snippet.
-- ----------------------------------------------------------------------------
create sequence if not exists public.client_code_seq;
create sequence if not exists public.ad_account_code_seq;

do $$
declare
  v_max int;
begin
  select coalesce(max((regexp_replace(client_code, '\D', '', 'g'))::int), 0)
    into v_max
    from public.clients
    where client_code ~ '^CL-[0-9]+$';
  perform setval('public.client_code_seq', greatest(v_max, 1), v_max > 0);
end $$;

alter table public.clients
  alter column client_code
  set default ('CL-' || lpad(nextval('public.client_code_seq')::text, 4, '0'));

-- ----------------------------------------------------------------------------
-- Ad accounts (spec §13)
-- ----------------------------------------------------------------------------
create table public.ad_accounts (
  id                  uuid primary key default gen_random_uuid(),
  account_code        text not null unique
                        default ('ADA-' || lpad(nextval('public.ad_account_code_seq')::text, 4, '0')),
  name                text not null,
  external_account_id text,
  platform            text not null default 'META',
  status              public.ad_account_status not null default 'AVAILABLE',
  current_limit_usd   numeric(18, 2) not null default 0 check (current_limit_usd >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Ad account assignments (spec §14)
-- ----------------------------------------------------------------------------
create table public.ad_account_assignments (
  id                uuid primary key default gen_random_uuid(),
  ad_account_id     uuid not null references public.ad_accounts (id),
  client_id         uuid not null references public.clients (id),
  opening_limit_usd numeric(18, 2) not null check (opening_limit_usd >= 0),
  closing_limit_usd numeric(18, 2) check (closing_limit_usd >= 0),
  assigned_at       timestamptz not null default now(),
  released_at       timestamptz,
  status            public.assignment_status not null default 'ACTIVE',
  assigned_by       uuid references auth.users (id),
  released_by       uuid references auth.users (id),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Business invariant (spec §14, Rule 2): at most one ACTIVE assignment per
-- ad account, enforced at the database level.
create unique index uniq_active_assignment_per_account
  on public.ad_account_assignments (ad_account_id)
  where status = 'ACTIVE';

-- Indexes (spec §79)
create index idx_ad_accounts_status on public.ad_accounts (status);
create index idx_ad_accounts_external on public.ad_accounts (external_account_id);
create index idx_assignments_account on public.ad_account_assignments (ad_account_id);
create index idx_assignments_client on public.ad_account_assignments (client_id);
create index idx_assignments_status on public.ad_account_assignments (status);

-- updated_at triggers
create trigger trg_ad_accounts_updated_at
  before update on public.ad_accounts
  for each row execute function public.set_updated_at();

create trigger trg_assignments_updated_at
  before update on public.ad_account_assignments
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Atomic operations (spec §31, §32). SECURITY DEFINER + row locking; execute
-- is granted to service_role only, so they run exclusively through the
-- authenticated + authorized TanStack Start server layer.
-- ----------------------------------------------------------------------------

-- Assign an AVAILABLE account to a client. Opening limit snapshots the
-- account's current limit (spec §15). Creates no due.
create or replace function public.assign_ad_account(
  p_account_id uuid,
  p_client_id  uuid,
  p_actor      uuid,
  p_notes      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account       public.ad_accounts;
  v_client_status public.client_status;
  v_assignment_id uuid;
begin
  select * into v_account from public.ad_accounts where id = p_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;
  if v_account.status = 'SUSPENDED' then
    raise exception 'Suspended accounts cannot be assigned';
  end if;

  select status into v_client_status from public.clients where id = p_client_id;
  if not found then raise exception 'Client not found'; end if;
  if v_client_status <> 'ACTIVE' then raise exception 'Client is not active'; end if;

  if exists (
    select 1 from public.ad_account_assignments
    where ad_account_id = p_account_id and status = 'ACTIVE'
  ) then
    raise exception 'Account already has an active assignment';
  end if;

  insert into public.ad_account_assignments
    (ad_account_id, client_id, opening_limit_usd, status, assigned_by, notes)
  values
    (p_account_id, p_client_id, v_account.current_limit_usd, 'ACTIVE', p_actor, p_notes)
  returning id into v_assignment_id;

  update public.ad_accounts set status = 'ACTIVE' where id = p_account_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, new_values)
  values
    (p_actor, 'ACCOUNT_ASSIGNED', 'AD_ACCOUNT', p_account_id::text,
     jsonb_build_object(
       'assignment_id', v_assignment_id,
       'client_id', p_client_id,
       'opening_limit_usd', v_account.current_limit_usd
     ));

  return v_assignment_id;
end;
$$;

-- Release the active assignment; account returns to AVAILABLE (spec §17).
create or replace function public.release_ad_account(
  p_account_id uuid,
  p_actor      uuid,
  p_notes      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account    public.ad_accounts;
  v_assignment public.ad_account_assignments;
begin
  select * into v_account from public.ad_accounts where id = p_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;

  select * into v_assignment
    from public.ad_account_assignments
    where ad_account_id = p_account_id and status = 'ACTIVE'
    for update;
  if not found then raise exception 'No active assignment to release'; end if;

  update public.ad_account_assignments
    set status = 'RELEASED',
        released_at = now(),
        released_by = p_actor,
        closing_limit_usd = v_account.current_limit_usd,
        notes = coalesce(p_notes, notes)
    where id = v_assignment.id;

  update public.ad_accounts set status = 'AVAILABLE' where id = p_account_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values)
  values
    (p_actor, 'ACCOUNT_RELEASED', 'AD_ACCOUNT', p_account_id::text,
     jsonb_build_object('client_id', v_assignment.client_id),
     jsonb_build_object(
       'assignment_id', v_assignment.id,
       'closing_limit_usd', v_account.current_limit_usd
     ));

  return v_assignment.id;
end;
$$;

-- Transfer the active assignment to another client (spec §16). Closes the old
-- assignment (closing = current limit) and opens a new one (opening = current
-- limit). New client owes nothing for the carried-over limit.
create or replace function public.transfer_ad_account(
  p_account_id   uuid,
  p_to_client_id uuid,
  p_actor        uuid,
  p_notes        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account       public.ad_accounts;
  v_client_status public.client_status;
  v_old           public.ad_account_assignments;
  v_new_id        uuid;
begin
  select * into v_account from public.ad_accounts where id = p_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;

  select status into v_client_status from public.clients where id = p_to_client_id;
  if not found then raise exception 'Target client not found'; end if;
  if v_client_status <> 'ACTIVE' then raise exception 'Target client is not active'; end if;

  select * into v_old
    from public.ad_account_assignments
    where ad_account_id = p_account_id and status = 'ACTIVE'
    for update;
  if not found then raise exception 'No active assignment to transfer'; end if;
  if v_old.client_id = p_to_client_id then
    raise exception 'Account is already assigned to this client';
  end if;

  update public.ad_account_assignments
    set status = 'RELEASED',
        released_at = now(),
        released_by = p_actor,
        closing_limit_usd = v_account.current_limit_usd
    where id = v_old.id;

  insert into public.ad_account_assignments
    (ad_account_id, client_id, opening_limit_usd, status, assigned_by, notes)
  values
    (p_account_id, p_to_client_id, v_account.current_limit_usd, 'ACTIVE', p_actor, p_notes)
  returning id into v_new_id;

  update public.ad_accounts set status = 'ACTIVE' where id = p_account_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values)
  values
    (p_actor, 'ACCOUNT_TRANSFERRED', 'AD_ACCOUNT', p_account_id::text,
     jsonb_build_object(
       'from_client_id', v_old.client_id,
       'from_assignment_id', v_old.id,
       'closing_limit_usd', v_account.current_limit_usd
     ),
     jsonb_build_object(
       'to_client_id', p_to_client_id,
       'to_assignment_id', v_new_id,
       'opening_limit_usd', v_account.current_limit_usd
     ));

  return v_new_id;
end;
$$;

revoke all on function public.assign_ad_account(uuid, uuid, uuid, text) from public;
revoke all on function public.release_ad_account(uuid, uuid, text) from public;
revoke all on function public.transfer_ad_account(uuid, uuid, uuid, text) from public;
grant execute on function public.assign_ad_account(uuid, uuid, uuid, text) to service_role;
grant execute on function public.release_ad_account(uuid, uuid, text) to service_role;
grant execute on function public.transfer_ad_account(uuid, uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- Row Level Security (SELECT-only for browser; writes go through the server)
-- ----------------------------------------------------------------------------
alter table public.ad_accounts enable row level security;
alter table public.ad_account_assignments enable row level security;

-- Admins see all accounts; clients see accounts currently assigned to them.
create policy ad_accounts_select on public.ad_accounts
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.ad_account_assignments a
      where a.ad_account_id = ad_accounts.id
        and a.status = 'ACTIVE'
        and public.is_client_member(a.client_id)
    )
  );

-- Admins see all assignments; clients see their own client's assignment
-- history (spec §14 history must remain accessible to the owning client).
create policy assignments_select on public.ad_account_assignments
  for select to authenticated
  using (public.is_admin() or public.is_client_member(client_id));
