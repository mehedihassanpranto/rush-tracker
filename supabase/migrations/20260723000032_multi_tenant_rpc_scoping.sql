-- ============================================================================
-- Rush Tracker — Multi-tenant conversion, Phase 1B (SQL half): organization
-- scoping for every RPC that either (a) aggregates across ALL clients with
-- no per-row org check (would mix organizations' totals together), or (b)
-- writes new rows by looking up an existing entity by id with no ownership
-- check (a cross-org admin who somehow knew/guessed another org's id could
-- act on their data — an IDOR). Companion to 20260723000031's schema/RLS
-- work and the server-fn (src/server/**/*.fns.ts) query-scoping pass.
--
-- Not touched: client_financials(p_client_id) — takes an explicit client_id
-- already; callers now validate that id belongs to their own organization
-- BEFORE calling it (src/server layer), so the function itself doesn't need
-- an org parameter. Every other function below either scans without a
-- client_id (needs an explicit p_organization_id to know which org to scan)
-- or looks up a row by an id that could — once a second org exists — belong
-- to someone else (needs an explicit ownership check before acting).
--
-- CRITICAL FIX included here: reset_all_data() previously used
-- `TRUNCATE ... CASCADE`, which empties a table for EVERY organization —
-- in a multi-tenant world, any org's own admin clicking Settings > Danger
-- Zone > "Clear all data" would have wiped every other customer's data too.
-- Converted to per-table `DELETE ... WHERE organization_id = ...`, scoped to
-- the caller's own organization only. This also means the global document-
-- code sequences (client_code_seq, ad_account_code_seq, etc. — shared
-- across ALL organizations, not per-org) can no longer be reset by this
-- function: resetting a shared counter because one org cleared their data
-- would renumber/collide codes for every OTHER still-live organization. The
-- sequence-reset step is removed entirely. This is a real, deliberate
-- behavior change for org zero's own "Clear all data" (codes no longer
-- restart at 0001 afterward) — unavoidable once codes are shared across
-- tenants, flagged explicitly rather than silently dropped.
--
-- Error messages for cross-org mismatches reuse the same "not found"
-- wording the function already uses for a genuinely missing row, rather
-- than a distinguishable "belongs to another organization" message — this
-- avoids confirming to a caller that an id they don't have access to
-- exists at all.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Aggregate reads: add p_organization_id, filter internally. No change to
-- any of the underlying math.
-- ----------------------------------------------------------------------------
drop function if exists public.total_outstanding_due();

create or replace function public.total_outstanding_due(p_organization_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(debit_bdt), 0) - coalesce(sum(credit_bdt), 0)
  from public.ledger_entries
  where organization_id = p_organization_id;
$$;

revoke all on function public.total_outstanding_due(uuid) from public;
grant execute on function public.total_outstanding_due(uuid) to service_role;

drop function if exists public.all_client_dues();

create or replace function public.all_client_dues(p_organization_id uuid)
returns table (
  client_id    uuid,
  client_code  text,
  name         text,
  status       public.client_status,
  total_billed numeric,
  total_paid   numeric,
  current_due  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.client_code,
    c.name,
    c.status,
    coalesce(sum(l.debit_bdt), 0) as total_billed,
    coalesce(sum(l.credit_bdt), 0) as total_paid,
    coalesce(sum(l.debit_bdt), 0) - coalesce(sum(l.credit_bdt), 0) as current_due
  from public.clients c
  left join public.ledger_entries l on l.client_id = c.id
  where c.organization_id = p_organization_id
  group by c.id, c.client_code, c.name, c.status
  order by current_due desc, c.name;
$$;

revoke all on function public.all_client_dues(uuid) from public;
grant execute on function public.all_client_dues(uuid) to service_role;

drop function if exists public.admin_today_totals();

create or replace function public.admin_today_totals(p_organization_id uuid)
returns table (
  approved_limit_usd   numeric,
  approved_billing_bdt numeric,
  collection_bdt       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(usd_amount) filter (where type = 'LIMIT_APPROVAL'), 0),
    coalesce(sum(debit_bdt) filter (where type = 'LIMIT_APPROVAL'), 0),
    coalesce(sum(credit_bdt) filter (where type = 'PAYMENT'), 0)
  from public.ledger_entries
  where organization_id = p_organization_id
    and (created_at at time zone 'Asia/Dhaka')::date
      = (now() at time zone 'Asia/Dhaka')::date;
$$;

revoke all on function public.admin_today_totals(uuid) from public;
grant execute on function public.admin_today_totals(uuid) to service_role;

drop function if exists public.top_due_clients(int);

-- p_organization_id has no default, so (per Postgres's rule that every
-- parameter after the first DEFAULT must also have one) it must come before
-- p_limit. Callers already use named-argument RPC calls, so this reordering
-- doesn't affect them.
create or replace function public.top_due_clients(p_organization_id uuid, p_limit int default 5)
returns table (
  client_id   uuid,
  client_code text,
  name        text,
  current_due numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.client_code,
    c.name,
    coalesce(sum(l.debit_bdt), 0) - coalesce(sum(l.credit_bdt), 0) as current_due
  from public.clients c
  join public.ledger_entries l on l.client_id = c.id
  where c.organization_id = p_organization_id
  group by c.id, c.client_code, c.name
  having coalesce(sum(l.debit_bdt), 0) - coalesce(sum(l.credit_bdt), 0) > 0
  order by current_due desc
  limit p_limit;
$$;

revoke all on function public.top_due_clients(uuid, int) from public;
grant execute on function public.top_due_clients(uuid, int) to service_role;

-- ----------------------------------------------------------------------------
-- assign_ad_account / release_ad_account / transfer_ad_account: validate
-- every referenced entity belongs to the caller's organization before
-- acting, tag new ad_account_assignments/audit_logs rows with it.
-- ----------------------------------------------------------------------------
drop function if exists public.assign_ad_account(uuid, uuid, uuid, text);

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
  if v_account.organization_id <> p_organization_id then
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

revoke all on function public.assign_ad_account(uuid, uuid, uuid, uuid, text) from public;
grant execute on function public.assign_ad_account(uuid, uuid, uuid, uuid, text) to service_role;

drop function if exists public.release_ad_account(uuid, uuid, text);

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
  if v_account.organization_id <> p_organization_id then
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

revoke all on function public.release_ad_account(uuid, uuid, uuid, text) from public;
grant execute on function public.release_ad_account(uuid, uuid, uuid, text) to service_role;

drop function if exists public.transfer_ad_account(uuid, uuid, uuid, text);

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
  if v_account.organization_id <> p_organization_id then
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

revoke all on function public.transfer_ad_account(uuid, uuid, uuid, uuid, text) from public;
grant execute on function public.transfer_ad_account(uuid, uuid, uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- create_adjustment / reverse_financial_transaction
-- ----------------------------------------------------------------------------
drop function if exists public.create_adjustment(uuid, text, numeric, text, text, uuid);

create or replace function public.create_adjustment(
  p_client_id       uuid,
  p_type            text,
  p_amount          numeric,
  p_reason          text,
  p_internal_note   text,
  p_actor           uuid,
  p_organization_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_led_type public.ledger_entry_type;
  v_debit    numeric(18, 2) := 0;
  v_credit   numeric(18, 2) := 0;
  v_ledger_id uuid;
  v_adj_id   uuid;
  v_client_org uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required';
  end if;

  select organization_id into v_client_org from public.clients where id = p_client_id;
  if not found then raise exception 'Client not found'; end if;
  if v_client_org <> p_organization_id then raise exception 'Client not found'; end if;

  if p_type = 'ADD_DUE' then
    v_led_type := 'ADJUSTMENT_DEBIT';
    v_debit := p_amount;
  elsif p_type = 'REDUCE_DUE' then
    v_led_type := 'ADJUSTMENT_CREDIT';
    v_credit := p_amount;
  else
    raise exception 'Invalid adjustment type: %', p_type;
  end if;

  insert into public.ledger_entries
    (client_id, type, reference_type, bdt_amount, debit_bdt, credit_bdt, description, created_by, organization_id)
  values
    (p_client_id, v_led_type, 'ADJUSTMENT', p_amount, v_debit, v_credit, p_reason, p_actor, p_organization_id)
  returning id into v_ledger_id;

  insert into public.adjustments
    (client_id, type, amount_bdt, reference_type, reference_id, ledger_entry_id,
     reason, internal_note, created_by, organization_id)
  values
    (p_client_id, p_type::public.adjustment_type, p_amount, 'LEDGER_ENTRY',
     v_ledger_id::text, v_ledger_id, p_reason, p_internal_note, p_actor, p_organization_id)
  returning id into v_adj_id;

  update public.ledger_entries
    set reference_id = v_adj_id::text
    where id = v_ledger_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, new_values, organization_id)
  values
    (p_actor, 'ADJUSTMENT_CREATED', 'ADJUSTMENT', v_adj_id::text,
     jsonb_build_object('client_id', p_client_id, 'type', p_type, 'amount_bdt', p_amount), p_organization_id);

  return v_adj_id;
end;
$$;

revoke all on function public.create_adjustment(uuid, text, numeric, text, text, uuid, uuid) from public;
grant execute on function public.create_adjustment(uuid, text, numeric, text, text, uuid, uuid) to service_role;

drop function if exists public.reverse_financial_transaction(uuid, text, uuid);

create or replace function public.reverse_financial_transaction(
  p_ledger_id       uuid,
  p_reason          text,
  p_actor           uuid,
  p_organization_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orig      public.ledger_entries;
  v_amount    numeric(18, 2);
  v_new_id    uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required';
  end if;

  select * into v_orig from public.ledger_entries where id = p_ledger_id for update;
  if not found then raise exception 'Ledger entry not found'; end if;
  if v_orig.organization_id <> p_organization_id then
    raise exception 'Ledger entry not found';
  end if;
  if v_orig.type = 'REVERSAL' then
    raise exception 'A reversal cannot itself be reversed';
  end if;

  if exists (
    select 1 from public.ledger_entries
    where type = 'REVERSAL'
      and reference_type = 'LEDGER_ENTRY'
      and reference_id = p_ledger_id::text
  ) then
    raise exception 'This transaction has already been reversed';
  end if;

  v_amount := greatest(v_orig.debit_bdt, v_orig.credit_bdt);

  -- Opposite effect: swap debit/credit. organization_id carried over from
  -- the original entry (already validated equal to p_organization_id above).
  insert into public.ledger_entries
    (client_id, type, reference_type, reference_id, usd_amount, usd_rate,
     bdt_amount, debit_bdt, credit_bdt, description, created_by, organization_id)
  values
    (v_orig.client_id, 'REVERSAL', 'LEDGER_ENTRY', p_ledger_id::text,
     v_orig.usd_amount, v_orig.usd_rate, v_amount,
     v_orig.credit_bdt, v_orig.debit_bdt,
     'Reversal of ' || v_orig.transaction_number || ': ' || p_reason, p_actor, v_orig.organization_id)
  returning id into v_new_id;

  insert into public.adjustments
    (client_id, type, amount_bdt, reference_type, reference_id, ledger_entry_id,
     reason, created_by, organization_id)
  values
    (v_orig.client_id, 'REVERSAL', v_amount, 'LEDGER_ENTRY', p_ledger_id::text,
     v_new_id, p_reason, p_actor, v_orig.organization_id);

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
  values
    (p_actor, 'REVERSAL_CREATED', 'LEDGER_ENTRY', p_ledger_id::text,
     jsonb_build_object(
       'original_transaction', v_orig.transaction_number,
       'original_type', v_orig.type
     ),
     jsonb_build_object('reversal_ledger_id', v_new_id, 'amount_bdt', v_amount, 'reason', p_reason),
     v_orig.organization_id);

  return v_new_id;
end;
$$;

revoke all on function public.reverse_financial_transaction(uuid, text, uuid, uuid) from public;
grant execute on function public.reverse_financial_transaction(uuid, text, uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- approve_limit_request / rebase_limit_request
-- ----------------------------------------------------------------------------
drop function if exists public.approve_limit_request(uuid, numeric, numeric, uuid, text);

create or replace function public.approve_limit_request(
  p_request_id      uuid,
  p_approved_amount numeric,
  p_approved_rate   numeric,
  p_actor           uuid,
  p_organization_id uuid,
  p_admin_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req        public.limit_requests;
  v_account    public.ad_accounts;
  v_assignment public.ad_account_assignments;
  v_new_limit  numeric(18, 2);
  v_charge     numeric(18, 2);
  v_ledger_id  uuid;
  v_payment_id uuid;
  v_payment_ledger_id uuid;
begin
  if p_approved_amount is null or p_approved_amount <= 0 then
    raise exception 'Approved amount must be greater than zero';
  end if;
  if p_approved_rate is null or p_approved_rate <= 0 then
    raise exception 'USD rate must be greater than zero';
  end if;

  -- Lock the request and verify it is still pending (blocks double approval).
  select * into v_req from public.limit_requests where id = p_request_id for update;
  if not found then raise exception 'Limit request not found'; end if;
  if v_req.organization_id <> p_organization_id then
    raise exception 'Limit request not found';
  end if;
  if v_req.status <> 'PENDING' then
    raise exception 'Request is not pending (current status: %)', v_req.status;
  end if;

  -- Lock the ad account and its active assignment.
  select * into v_account from public.ad_accounts where id = v_req.ad_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;

  select * into v_assignment
    from public.ad_account_assignments
    where id = v_req.assignment_id
    for update;
  if not found then raise exception 'Assignment not found'; end if;
  if v_assignment.status <> 'ACTIVE' or v_assignment.client_id <> v_req.client_id then
    raise exception 'The account is no longer actively assigned to this client';
  end if;
  if v_account.status = 'INACTIVE' or v_account.status = 'SUSPENDED' then
    raise exception 'Account is % and cannot receive limit approvals', v_account.status;
  end if;

  -- Stale opening balance protection (spec §30): the baseline must still match.
  if v_req.opening_balance_usd <> v_account.current_limit_usd then
    raise exception 'STALE_BASELINE: request opening balance is %, but the account current limit is now %. Rebase before approving.',
      v_req.opening_balance_usd, v_account.current_limit_usd;
  end if;

  -- Authoritative, decimal-safe calculation (spec §28).
  v_new_limit := v_req.opening_balance_usd + p_approved_amount;
  v_charge := round(p_approved_amount * p_approved_rate, 2);

  update public.limit_requests
    set approved_amount_usd    = p_approved_amount,
        approved_usd_rate      = p_approved_rate,
        approved_new_limit_usd = v_new_limit,
        bdt_charge             = v_charge,
        status                 = 'APPROVED',
        reviewed_by            = p_actor,
        reviewed_at            = now(),
        approved_at            = now(),
        admin_note             = p_admin_note
    where id = p_request_id;

  update public.ad_accounts
    set current_limit_usd = v_new_limit
    where id = v_req.ad_account_id;

  insert into public.ledger_entries
    (client_id, type, reference_type, reference_id,
     usd_amount, usd_rate, bdt_amount, debit_bdt, credit_bdt, description, created_by, organization_id)
  values
    (v_req.client_id, 'LIMIT_APPROVAL', 'LIMIT_REQUEST', p_request_id::text,
     p_approved_amount, p_approved_rate, v_charge, v_charge, 0,
     'Limit approval ' || v_req.request_number, p_actor, v_req.organization_id)
  returning id into v_ledger_id;

  -- Prepaid AND partial: the client already paid amount_paid_bdt up front
  -- (proof attached at submission) — record it as an APPROVED payment +
  -- matching PAYMENT ledger credit. Postpaid requests never have a positive
  -- amount_paid_bdt, so this naturally no-ops for them.
  if v_req.segment <> 'postpaid' and coalesce(v_req.amount_paid_bdt, 0) > 0 then
    insert into public.payments
      (client_id, amount_bdt, payment_method, transaction_reference, status,
       submitted_by, reviewed_by, reviewed_at, organization_id)
    values
      (v_req.client_id, v_req.amount_paid_bdt, 'Limit Request Prepayment',
       v_req.request_number, 'APPROVED', v_req.requested_by, p_actor, now(), v_req.organization_id)
    returning id into v_payment_id;

    insert into public.ledger_entries
      (client_id, type, reference_type, reference_id, bdt_amount, debit_bdt, credit_bdt, description, created_by, organization_id)
    values
      (v_req.client_id, 'PAYMENT', 'PAYMENT', v_payment_id::text,
       v_req.amount_paid_bdt, 0, v_req.amount_paid_bdt,
       'Prepayment for ' || v_req.request_number, p_actor, v_req.organization_id)
    returning id into v_payment_ledger_id;

    insert into public.audit_logs
      (actor_user_id, action, entity_type, entity_id, new_values, organization_id)
    values
      (p_actor, 'PAYMENT_APPROVED', 'PAYMENT', v_payment_id::text,
       jsonb_build_object(
         'amount_bdt', v_req.amount_paid_bdt,
         'ledger_id', v_payment_ledger_id,
         'source', 'LIMIT_REQUEST_AUTO_PAYMENT',
         'limit_request_id', p_request_id
       ), v_req.organization_id);
  end if;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
  values
    (p_actor, 'LIMIT_REQUEST_APPROVED', 'LIMIT_REQUEST', p_request_id::text,
     jsonb_build_object(
       'requested_amount_usd', v_req.requested_amount_usd,
       'opening_balance_usd', v_req.opening_balance_usd,
       'default_usd_rate', v_req.default_usd_rate
     ),
     jsonb_build_object(
       'approved_amount_usd', p_approved_amount,
       'approved_usd_rate', p_approved_rate,
       'approved_new_limit_usd', v_new_limit,
       'bdt_charge', v_charge,
       'amount_changed', p_approved_amount <> v_req.requested_amount_usd,
       'rate_changed', p_approved_rate <> v_req.default_usd_rate,
       'ledger_id', v_ledger_id,
       'payment_id', v_payment_id
     ), v_req.organization_id);

  return jsonb_build_object(
    'ledger_id', v_ledger_id,
    'payment_id', v_payment_id,
    'payment_ledger_id', v_payment_ledger_id
  );
end;
$$;

revoke all on function public.approve_limit_request(uuid, numeric, numeric, uuid, uuid, text) from public;
grant execute on function public.approve_limit_request(uuid, numeric, numeric, uuid, uuid, text) to service_role;

drop function if exists public.rebase_limit_request(uuid, uuid);

create or replace function public.rebase_limit_request(
  p_request_id      uuid,
  p_actor           uuid,
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req     public.limit_requests;
  v_account public.ad_accounts;
  v_new_expected numeric(18, 2);
begin
  select * into v_req from public.limit_requests where id = p_request_id for update;
  if not found then raise exception 'Limit request not found'; end if;
  if v_req.organization_id <> p_organization_id then
    raise exception 'Limit request not found';
  end if;
  if v_req.status <> 'PENDING' then raise exception 'Request is not pending'; end if;

  select * into v_account from public.ad_accounts where id = v_req.ad_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;

  v_new_expected := v_account.current_limit_usd + v_req.requested_amount_usd;

  update public.limit_requests
    set opening_balance_usd    = v_account.current_limit_usd,
        expected_new_limit_usd = v_new_expected
    where id = p_request_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
  values
    (p_actor, 'LIMIT_REQUEST_REBASED', 'LIMIT_REQUEST', p_request_id::text,
     jsonb_build_object('opening_balance_usd', v_req.opening_balance_usd),
     jsonb_build_object(
       'opening_balance_usd', v_account.current_limit_usd,
       'expected_new_limit_usd', v_new_expected
     ), v_req.organization_id);
end;
$$;

revoke all on function public.rebase_limit_request(uuid, uuid, uuid) from public;
grant execute on function public.rebase_limit_request(uuid, uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- approve_payment
-- ----------------------------------------------------------------------------
drop function if exists public.approve_payment(uuid, uuid, numeric);

create or replace function public.approve_payment(
  p_payment_id      uuid,
  p_actor           uuid,
  p_organization_id uuid,
  p_amount_bdt      numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
v_pay      public.payments;
v_req      public.payment_requests;
v_ledger_id uuid;
v_total_approved numeric(18, 2);
v_final_amount numeric(18, 2);
begin
select * into v_pay from public.payments where id = p_payment_id for update;
if not found then raise exception 'Payment not found'; end if;
if v_pay.organization_id <> p_organization_id then
  raise exception 'Payment not found';
end if;
if v_pay.status <> 'PENDING' then
raise exception 'Payment is not pending (current status: %)', v_pay.status;
end if;

if p_amount_bdt is not null and p_amount_bdt <= 0 then
  raise exception 'Amount must be greater than zero';
end if;

v_final_amount := coalesce(p_amount_bdt, v_pay.amount_bdt);

if p_amount_bdt is not null and p_amount_bdt <> v_pay.amount_bdt then
  update public.payments set amount_bdt = p_amount_bdt where id = p_payment_id;
end if;

update public.payments
set status = 'APPROVED', reviewed_by = p_actor, reviewed_at = now()
where id = p_payment_id;

insert into public.ledger_entries
(client_id, type, reference_type, reference_id, bdt_amount, debit_bdt, credit_bdt, description, created_by, organization_id)
values
(v_pay.client_id, 'PAYMENT', 'PAYMENT', p_payment_id::text,
  v_final_amount, 0, v_final_amount, 'Payment ' || v_pay.payment_number, p_actor, v_pay.organization_id)
returning id into v_ledger_id;

-- Advance the linked payment request's status if applicable (spec §47).
if v_pay.payment_request_id is not null then
select * into v_req from public.payment_requests
  where id = v_pay.payment_request_id for update;
if found then
  select coalesce(sum(amount_bdt), 0) into v_total_approved
    from public.payments
    where payment_request_id = v_req.id and status = 'APPROVED';
  update public.payment_requests
    set status = case
      when v_total_approved >= v_req.requested_amount_bdt then 'PAID'
      else 'PARTIALLY_PAID'
    end
    where id = v_req.id;
end if;
end if;

insert into public.audit_logs
(actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
values
(p_actor, 'PAYMENT_APPROVED', 'PAYMENT', p_payment_id::text,
  case when p_amount_bdt is not null and p_amount_bdt <> v_pay.amount_bdt
    then jsonb_build_object('amount_bdt', v_pay.amount_bdt) else null end,
  jsonb_build_object('amount_bdt', v_final_amount, 'ledger_id', v_ledger_id),
  v_pay.organization_id);

return v_ledger_id;
end;
$$;

revoke all on function public.approve_payment(uuid, uuid, uuid, numeric) from public;
grant execute on function public.approve_payment(uuid, uuid, uuid, numeric) to service_role;

-- ----------------------------------------------------------------------------
-- submit_payment
-- ----------------------------------------------------------------------------
drop function if exists public.submit_payment(uuid, numeric, text, text, uuid, uuid);

create or replace function public.submit_payment(
  p_client_id             uuid,
  p_amount_bdt            numeric,
  p_payment_method        text,
  p_transaction_reference text,
  p_payment_request_id    uuid,
  p_actor                 uuid,
  p_organization_id       uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org       uuid;
  v_due       numeric(18, 2);
  v_pending   numeric(18, 2);
  v_outstanding numeric(18, 2);
  v_payment_id uuid;
begin
  if p_amount_bdt is null or p_amount_bdt <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  -- Lock the client row first so a concurrent submit_payment call for the
  -- same client blocks until this transaction commits — the read of
  -- due/pending below can then never race a second insert.
  select organization_id into v_org from public.clients where id = p_client_id for update;
  if not found then raise exception 'Client not found'; end if;
  if v_org <> p_organization_id then raise exception 'Client not found'; end if;

  -- client_financials() defines due as debits - credits; mirror that here
  -- rather than depending on it, since we're already inside the lock.
  select coalesce(sum(debit_bdt), 0) - coalesce(sum(credit_bdt), 0)
    into v_due
    from public.ledger_entries
    where client_id = p_client_id;

  select coalesce(sum(amount_bdt), 0)
    into v_pending
    from public.payments
    where client_id = p_client_id and status = 'PENDING';

  v_outstanding := v_due - v_pending;

  if v_outstanding <= 0 then
    raise exception 'OVERPAYMENT: you have no outstanding due to pay right now';
  end if;
  if p_amount_bdt > v_outstanding then
    raise exception 'OVERPAYMENT: amount exceeds your outstanding due of %', v_outstanding;
  end if;

  if p_payment_request_id is not null then
    if not exists (
      select 1 from public.payment_requests
      where id = p_payment_request_id and client_id = p_client_id
    ) then
      raise exception 'Payment request not found';
    end if;
  end if;

  insert into public.payments
    (client_id, payment_request_id, amount_bdt, payment_method,
     transaction_reference, submitted_by, status, organization_id)
  values
    (p_client_id, p_payment_request_id, p_amount_bdt, p_payment_method,
     p_transaction_reference, p_actor, 'PENDING', v_org)
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

revoke all on function public.submit_payment(uuid, numeric, text, text, uuid, uuid, uuid) from public;
grant execute on function public.submit_payment(uuid, numeric, text, text, uuid, uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- reset_all_data: TRUNCATE -> per-organization DELETE. See header note on
-- why the global document-code sequences can no longer be reset here.
-- ----------------------------------------------------------------------------
drop function if exists public.reset_all_data();

create or replace function public.reset_all_data(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1) Delete this organization's rows only, children before parents.
  --    exchange_rates is preserved so the configured USD rate (needed for
  --    billing + USD display) survives, matching the original behavior.
  delete from public.notifications where organization_id = p_organization_id;
  delete from public.audit_logs where organization_id = p_organization_id;
  delete from public.adjustments where organization_id = p_organization_id;
  delete from public.payments where organization_id = p_organization_id;
  delete from public.payment_requests where organization_id = p_organization_id;
  delete from public.ledger_entries where organization_id = p_organization_id;
  delete from public.attachments where organization_id = p_organization_id;
  delete from public.limit_requests where organization_id = p_organization_id;
  delete from public.ad_account_assignments where organization_id = p_organization_id;
  delete from public.ad_accounts where organization_id = p_organization_id;
  delete from public.client_employees where organization_id = p_organization_id;
  delete from public.employees where organization_id = p_organization_id;
  delete from public.client_memberships where organization_id = p_organization_id;
  delete from public.clients where organization_id = p_organization_id;

  -- 2) Delete every CLIENT login belonging to THIS organization (cascades
  --    their profile + any remaining memberships).
  delete from auth.users
  where id in (
    select p.user_id
    from public.user_profiles p
    join public.roles r on r.id = p.role_id
    where r.key = 'CLIENT' and p.organization_id = p_organization_id
  );

  -- NOTE: the document-code sequences (client_code_seq, ad_account_code_seq,
  -- limit_request_seq, ledger_txn_seq, payment_seq, payment_request_seq,
  -- adjustment_seq, employee_code_seq) are shared across ALL organizations
  -- and are deliberately NOT reset here anymore — see header note.
end;
$$;

revoke all on function public.reset_all_data(uuid) from public;
grant execute on function public.reset_all_data(uuid) to service_role;
