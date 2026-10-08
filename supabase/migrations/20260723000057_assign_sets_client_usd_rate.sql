-- ============================================================================
-- Assigning or transferring an ad account sets its USD rate to the client's.
--
-- An account's own usd_rate wins over the client's (adAccountUsdRate(); 0 =
-- inherit), so a rate left over from the previous client — or from a bulk
-- import — kept billing the new client at the old rate. Owner request
-- (2026-10-06): on assign and on transfer, copy the receiving client's rate
-- onto the account. Admins can still change an account's rate afterwards.
-- A client with no rate (0) leaves the account at 0, i.e. inherit.
--
-- Same bodies as 000036 plus the rate update and old/new rate in the audit
-- row. Signatures unchanged, so create or replace; privileges re-asserted
-- (service_role only, migrations 000050–52). Existing assignments are NOT
-- changed by this migration.
-- ============================================================================

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
  v_client_rate   numeric;
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

  select status, organization_id, usd_rate into v_client_status, v_client_org, v_client_rate
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

  -- The account takes the new client's rate (owner request, 2026-10-06).
  update public.ad_accounts
    set status = 'ACTIVE', usd_rate = v_client_rate
    where id = p_account_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, new_values, organization_id)
  values
    (p_actor, 'ACCOUNT_ASSIGNED', 'AD_ACCOUNT', p_account_id::text,
     jsonb_build_object(
       'assignment_id', v_assignment_id,
       'client_id', p_client_id,
       'opening_limit_usd', v_account.current_limit_usd,
       'previous_usd_rate', v_account.usd_rate,
       'usd_rate', v_client_rate
     ), p_organization_id);

  return v_assignment_id;
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
  v_client_rate   numeric;
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

  select status, organization_id, usd_rate into v_client_status, v_client_org, v_client_rate
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

  -- The account takes the receiving client's rate (owner request, 2026-10-06).
  update public.ad_accounts
    set status = 'ACTIVE', usd_rate = v_client_rate
    where id = p_account_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
  values
    (p_actor, 'ACCOUNT_TRANSFERRED', 'AD_ACCOUNT', p_account_id::text,
     jsonb_build_object(
       'from_client_id', v_old.client_id,
       'from_assignment_id', v_old.id,
       'closing_limit_usd', v_account.current_limit_usd,
       'usd_rate', v_account.usd_rate
     ),
     jsonb_build_object(
       'to_client_id', p_to_client_id,
       'to_assignment_id', v_new_id,
       'opening_limit_usd', v_account.current_limit_usd,
       'usd_rate', v_client_rate
     ), p_organization_id);

  return v_new_id;
end;
$$;

revoke all on function public.assign_ad_account(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.assign_ad_account(uuid, uuid, uuid, uuid, text) to service_role;
revoke all on function public.transfer_ad_account(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.transfer_ad_account(uuid, uuid, uuid, uuid, text) to service_role;
