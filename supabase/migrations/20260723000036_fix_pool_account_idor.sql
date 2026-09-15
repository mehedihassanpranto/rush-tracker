-- ============================================================================
-- Rush Tracker — fix: pool accounts bypassed the assignment RPCs' IDOR guard.
--
-- SECURITY FIX. `assign_ad_account`, `release_ad_account` and
-- `transfer_ad_account` validated ownership with:
--
--     if v_account.organization_id <> p_organization_id then
--       raise exception 'Ad account not found';
--     end if;
--
-- That was correct while every ad account belonged to an agency. Migration
-- 20260723000035 introduced platform-owned pool accounts, whose
-- organization_id is NULL — and in SQL `NULL <> anything` is NULL, not true,
-- which PL/pgSQL's IF treats as false. The guard therefore never fired for a
-- pool account, so ANY organization could assign, release or transfer ANY
-- pool account, including one granted to a different agency.
--
-- Confirmed empirically before this fix: agency B successfully assigned a pool
-- account granted only to agency A to one of B's own clients, while the same
-- attempt against an account A *owned* was correctly refused.
--
-- The replacement asks the question that is actually correct now — "may this
-- organization use this account?" — which is owned-by-them OR granted-to-them,
-- the same union the server layer uses (src/server/ad-accounts/scope.server.ts).
-- It is NULL-safe because EXISTS always returns a real boolean.
--
-- The three functions are otherwise byte-identical to 20260723000032; only the
-- ownership check changed.
-- ============================================================================

create or replace function public.org_can_use_ad_account(
  p_account_id      uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.ad_accounts a
     where a.id = p_account_id
       and (
         a.organization_id = p_organization_id
         or (
           a.is_platform
           and exists (
             select 1
               from public.platform_account_grants g
              where g.ad_account_id = a.id
                and g.organization_id = p_organization_id
           )
         )
       )
  );
$$;

revoke all on function public.org_can_use_ad_account(uuid, uuid) from public;
grant execute on function public.org_can_use_ad_account(uuid, uuid) to service_role;

create or replace function public.assign_ad_account(
  p_account_id      uuid,
  p_client_id       uuid,
  p_actor           uuid,
  p_organization_id uuid,
  p_notes           text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account       public.ad_accounts;
  v_client_status public.client_status;
  v_client_org    uuid;
  v_assignment_id uuid;
begin
  select * into v_account from public.ad_accounts where id = p_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;
  -- Ownership check via the helper: a pool account's organization_id is NULL,
  -- and `NULL <> p_organization_id` evaluates to NULL, which PL/pgSQL treats
  -- as false — so the original comparison silently let ANY organization act on
  -- ANY pool account. See the migration header.
  if not public.org_can_use_ad_account(p_account_id, p_organization_id) then
    raise exception 'Ad account not found';
  end if;
  if v_account.status = 'SUSPENDED' then
    raise exception 'Suspended accounts cannot be assigned';
  end if;

  select status, organization_id into v_client_status, v_client_org
    from public.clients where id = p_client_id;
  if not found then raise exception 'Client not found'; end if;
  if v_client_org <> p_organization_id then raise exception 'Client not found'; end if;
  if v_client_status <> 'ACTIVE' then raise exception 'Client is not active'; end if;

  if exists (
    select 1 from public.ad_account_assignments
    where ad_account_id = p_account_id and status = 'ACTIVE'
  ) then
    raise exception 'Account already has an active assignment';
  end if;

  insert into public.ad_account_assignments
    (ad_account_id, client_id, opening_limit_usd, status, assigned_by, notes, organization_id)
  values
    (p_account_id, p_client_id, v_account.current_limit_usd, 'ACTIVE', p_actor, p_notes, p_organization_id)
  returning id into v_assignment_id;

  update public.ad_accounts set status = 'ACTIVE' where id = p_account_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, new_values, organization_id)
  values
    (p_actor, 'ACCOUNT_ASSIGNED', 'AD_ACCOUNT', p_account_id::text,
     jsonb_build_object(
       'assignment_id', v_assignment_id,
       'client_id', p_client_id,
       'opening_limit_usd', v_account.current_limit_usd
     ), p_organization_id);

  return v_assignment_id;
end;
$$;

create or replace function public.release_ad_account(
  p_account_id      uuid,
  p_actor           uuid,
  p_organization_id uuid,
  p_notes           text default null
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
  -- Ownership check via the helper: a pool account's organization_id is NULL,
  -- and `NULL <> p_organization_id` evaluates to NULL, which PL/pgSQL treats
  -- as false — so the original comparison silently let ANY organization act on
  -- ANY pool account. See the migration header.
  if not public.org_can_use_ad_account(p_account_id, p_organization_id) then
    raise exception 'Ad account not found';
  end if;

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
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
  values
    (p_actor, 'ACCOUNT_RELEASED', 'AD_ACCOUNT', p_account_id::text,
     jsonb_build_object('client_id', v_assignment.client_id),
     jsonb_build_object(
       'assignment_id', v_assignment.id,
       'closing_limit_usd', v_account.current_limit_usd
     ), p_organization_id);

  return v_assignment.id;
end;
$$;

create or replace function public.transfer_ad_account(
  p_account_id      uuid,
  p_to_client_id    uuid,
  p_actor           uuid,
  p_organization_id uuid,
  p_notes           text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account       public.ad_accounts;
  v_client_status public.client_status;
  v_client_org    uuid;
  v_old           public.ad_account_assignments;
  v_new_id        uuid;
begin
  select * into v_account from public.ad_accounts where id = p_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;
  -- Ownership check via the helper: a pool account's organization_id is NULL,
  -- and `NULL <> p_organization_id` evaluates to NULL, which PL/pgSQL treats
  -- as false — so the original comparison silently let ANY organization act on
  -- ANY pool account. See the migration header.
  if not public.org_can_use_ad_account(p_account_id, p_organization_id) then
    raise exception 'Ad account not found';
  end if;

  select status, organization_id into v_client_status, v_client_org
    from public.clients where id = p_to_client_id;
  if not found then raise exception 'Target client not found'; end if;
  if v_client_org <> p_organization_id then raise exception 'Target client not found'; end if;
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
    (ad_account_id, client_id, opening_limit_usd, status, assigned_by, notes, organization_id)
  values
    (p_account_id, p_to_client_id, v_account.current_limit_usd, 'ACTIVE', p_actor, p_notes, p_organization_id)
  returning id into v_new_id;

  update public.ad_accounts set status = 'ACTIVE' where id = p_account_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
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
     ), p_organization_id);

  return v_new_id;
end;
$$;
