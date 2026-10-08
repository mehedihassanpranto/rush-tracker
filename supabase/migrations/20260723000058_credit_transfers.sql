-- ============================================================================
-- Credit transfers: move unused limit between two ad accounts of ONE client.
--
-- Built from the owner's "Inter-Ad-Account Credit Transfer: Fixed Design"
-- with the owner's v1 decisions (2026-10-08):
--   - same client only — both accounts actively assigned to the same client.
--     Cross-client transfers are cut from v1 (no ledger entries, no billing
--     effect: the client already paid for the limit, it only moves);
--   - if either account is a platform pool account (is_platform), the agency
--     can only REQUEST; a platform admin executes (enforced here too, not
--     only in the server layer);
--   - Meta is updated afterwards by the existing exact-value spend-cap sync
--     (spend-cap-sync.server.ts), source first — no reversal state machine.
--
-- A transfer lowers the source's current_limit_usd and raises the
-- destination's by the same amount, in one locked transaction. It never
-- touches the ledger, usd_sales or any exchange rate.
--
-- Deletion: FKs to organizations / auth.users have no ON DELETE, so the table
-- is in OFFBOARD_ORDER / WIPE_ORDER (server) and in reset_all_data() below.
-- RLS on with zero policies: read only through the server layer.
-- New functions are service_role-only (migrations 000050–52).
-- ============================================================================

create sequence if not exists public.credit_transfer_seq;

create table public.credit_transfers (
  id                         uuid primary key default gen_random_uuid(),
  transfer_number            text not null unique
                               default ('CT-' || lpad(nextval('public.credit_transfer_seq')::text, 6, '0')),
  organization_id            uuid not null references public.organizations (id),
  client_id                  uuid not null references public.clients (id),
  source_account_id          uuid not null references public.ad_accounts (id),
  destination_account_id     uuid not null references public.ad_accounts (id),
  source_assignment_id       uuid not null references public.ad_account_assignments (id),
  destination_assignment_id  uuid not null references public.ad_account_assignments (id),
  amount_usd                 numeric(18, 2) not null check (amount_usd > 0),
  note                       text,
  status                     text not null
                               check (status in ('PENDING_PLATFORM_REVIEW', 'COMPLETED', 'REJECTED')),
  -- Limits before/after, recorded when executed.
  source_limit_before        numeric(18, 2),
  source_limit_after         numeric(18, 2),
  destination_limit_before   numeric(18, 2),
  destination_limit_after    numeric(18, 2),
  requested_by               uuid references auth.users (id),
  requested_at               timestamptz not null default now(),
  executed_by                uuid references auth.users (id),
  executed_at                timestamptz,
  rejected_by                uuid references auth.users (id),
  rejected_at                timestamptz,
  rejection_reason           text,
  created_at                 timestamptz not null default now(),
  check (source_account_id <> destination_account_id)
);

create index idx_credit_transfers_org on public.credit_transfers (organization_id, requested_at desc);
create index idx_credit_transfers_source on public.credit_transfers (source_account_id);
create index idx_credit_transfers_destination on public.credit_transfers (destination_account_id);
create index idx_credit_transfers_status on public.credit_transfers (status) where status = 'PENDING_PLATFORM_REVIEW';
-- One transfer awaiting review per account, on either side.
create unique index uniq_pending_transfer_source
  on public.credit_transfers (source_account_id) where status = 'PENDING_PLATFORM_REVIEW';
create unique index uniq_pending_transfer_destination
  on public.credit_transfers (destination_account_id) where status = 'PENDING_PLATFORM_REVIEW';

alter table public.credit_transfers enable row level security;

-- ----------------------------------------------------------------------------
-- Shared checks. Locks both accounts (in id order, so two transfers between
-- the same pair can't deadlock) and returns the client and both active
-- assignments. Raises CODE: message errors (friendly-unwrapped by the server).
-- ----------------------------------------------------------------------------
create or replace function public.credit_transfer_validate(
  p_organization_id uuid,
  p_source          uuid,
  p_destination     uuid,
  p_amount          numeric,
  p_ignore_transfer uuid,
  out client_id                 uuid,
  out source_assignment_id      uuid,
  out destination_assignment_id uuid,
  out source_limit              numeric,
  out destination_limit         numeric,
  out involves_pool             boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src  public.ad_accounts;
  v_dst  public.ad_accounts;
  v_sa   public.ad_account_assignments;
  v_da   public.ad_account_assignments;
  v_org  uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: Enter an amount greater than zero';
  end if;
  if p_source = p_destination then
    raise exception 'SAME_ACCOUNT: Choose two different ad accounts';
  end if;

  perform 1 from public.ad_accounts
    where id in (p_source, p_destination) order by id for update;

  select * into v_src from public.ad_accounts where id = p_source;
  select * into v_dst from public.ad_accounts where id = p_destination;
  if v_src.id is null or not public.org_can_use_ad_account(p_source, p_organization_id) then
    raise exception 'NOT_FOUND: Source ad account not found';
  end if;
  if v_dst.id is null or not public.org_can_use_ad_account(p_destination, p_organization_id) then
    raise exception 'NOT_FOUND: Destination ad account not found';
  end if;
  if v_src.status <> 'ACTIVE' or v_dst.status <> 'ACTIVE' then
    raise exception 'NOT_ACTIVE: Both ad accounts must be active';
  end if;

  select * into v_sa from public.ad_account_assignments
    where ad_account_id = p_source and status = 'ACTIVE' for update;
  select * into v_da from public.ad_account_assignments
    where ad_account_id = p_destination and status = 'ACTIVE' for update;
  if v_sa.id is null or v_da.id is null then
    raise exception 'NOT_ASSIGNED: Both ad accounts must be assigned to a client';
  end if;
  if v_sa.client_id <> v_da.client_id then
    raise exception 'DIFFERENT_CLIENTS: Credit can only move between accounts of the same client';
  end if;
  select organization_id into v_org from public.clients where id = v_sa.client_id;
  if v_org is distinct from p_organization_id then
    raise exception 'NOT_FOUND: Client not found';
  end if;

  if exists (
    select 1 from public.limit_requests
    where ad_account_id in (p_source, p_destination)
      and status in ('PENDING', 'PENDING_PLATFORM_REVIEW')
  ) then
    raise exception 'PENDING_LIMIT_REQUEST: Resolve the pending limit request on one of these accounts first';
  end if;
  if exists (
    select 1 from public.credit_transfers t
    where t.status = 'PENDING_PLATFORM_REVIEW'
      and t.id is distinct from p_ignore_transfer
      and (t.source_account_id in (p_source, p_destination)
           or t.destination_account_id in (p_source, p_destination))
  ) then
    raise exception 'PENDING_TRANSFER: One of these accounts already has a credit transfer awaiting review';
  end if;

  if v_src.current_limit_usd < p_amount then
    raise exception 'INSUFFICIENT_LIMIT: The source account''s limit is only % USD', v_src.current_limit_usd;
  end if;

  client_id := v_sa.client_id;
  source_assignment_id := v_sa.id;
  destination_assignment_id := v_da.id;
  source_limit := v_src.current_limit_usd;
  destination_limit := v_dst.current_limit_usd;
  involves_pool := v_src.is_platform or v_dst.is_platform;
end;
$$;

-- ----------------------------------------------------------------------------
-- Apply one transfer row: move the limit, record before/after, audit both
-- accounts. The row must be PENDING_PLATFORM_REVIEW (create_credit_transfer
-- inserts it in that state and applies it in the same transaction when the
-- agency may execute directly). A pool account requires a platform admin.
-- ----------------------------------------------------------------------------
create or replace function public.apply_credit_transfer(
  p_transfer_id uuid,
  p_actor       uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t      public.credit_transfers;
  v_check  record;
  v_is_platform_admin boolean;
begin
  select * into v_t from public.credit_transfers where id = p_transfer_id for update;
  if not found then raise exception 'NOT_FOUND: Credit transfer not found'; end if;
  if v_t.status <> 'PENDING_PLATFORM_REVIEW' then
    raise exception 'NOT_PENDING: This transfer is already %', lower(v_t.status);
  end if;

  select * into v_check from public.credit_transfer_validate(
    v_t.organization_id, v_t.source_account_id, v_t.destination_account_id,
    v_t.amount_usd, v_t.id);

  -- The accounts must still be with the same client the request was made for.
  if v_check.client_id <> v_t.client_id
     or v_check.source_assignment_id <> v_t.source_assignment_id
     or v_check.destination_assignment_id <> v_t.destination_assignment_id then
    raise exception 'REASSIGNED: One of the accounts was reassigned since this transfer was requested';
  end if;

  if v_check.involves_pool then
    select coalesce(is_platform_admin, false) into v_is_platform_admin
      from public.user_profiles where user_id = p_actor;
    if not coalesce(v_is_platform_admin, false) then
      raise exception 'PLATFORM_REVIEW_REQUIRED: A platform pool account is involved — the platform must approve this transfer';
    end if;
  end if;

  update public.ad_accounts
    set current_limit_usd = current_limit_usd - v_t.amount_usd
    where id = v_t.source_account_id;
  update public.ad_accounts
    set current_limit_usd = current_limit_usd + v_t.amount_usd
    where id = v_t.destination_account_id;

  update public.credit_transfers set
    status = 'COMPLETED',
    source_limit_before = v_check.source_limit,
    source_limit_after = v_check.source_limit - v_t.amount_usd,
    destination_limit_before = v_check.destination_limit,
    destination_limit_after = v_check.destination_limit + v_t.amount_usd,
    executed_by = p_actor,
    executed_at = now()
  where id = v_t.id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, metadata, organization_id)
  values
    (p_actor, 'CREDIT_TRANSFERRED_OUT', 'AD_ACCOUNT', v_t.source_account_id::text,
     jsonb_build_object('current_limit_usd', v_check.source_limit),
     jsonb_build_object('current_limit_usd', v_check.source_limit - v_t.amount_usd),
     jsonb_build_object('transfer_id', v_t.id, 'transfer_number', v_t.transfer_number,
                        'amount_usd', v_t.amount_usd, 'to_account_id', v_t.destination_account_id),
     v_t.organization_id),
    (p_actor, 'CREDIT_TRANSFERRED_IN', 'AD_ACCOUNT', v_t.destination_account_id::text,
     jsonb_build_object('current_limit_usd', v_check.destination_limit),
     jsonb_build_object('current_limit_usd', v_check.destination_limit + v_t.amount_usd),
     jsonb_build_object('transfer_id', v_t.id, 'transfer_number', v_t.transfer_number,
                        'amount_usd', v_t.amount_usd, 'from_account_id', v_t.source_account_id),
     v_t.organization_id);

  return jsonb_build_object('id', v_t.id, 'transfer_number', v_t.transfer_number, 'status', 'COMPLETED');
end;
$$;

-- ----------------------------------------------------------------------------
-- Create a transfer. p_execute = true applies it at once (agency-owned
-- accounts on both sides, or a platform admin); false leaves it awaiting
-- platform review.
-- ----------------------------------------------------------------------------
create or replace function public.create_credit_transfer(
  p_organization_id uuid,
  p_source          uuid,
  p_destination     uuid,
  p_amount          numeric,
  p_note            text,
  p_actor           uuid,
  p_execute         boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check  record;
  v_id     uuid;
  v_number text;
begin
  select * into v_check from public.credit_transfer_validate(
    p_organization_id, p_source, p_destination, round(p_amount, 2), null);

  insert into public.credit_transfers
    (organization_id, client_id, source_account_id, destination_account_id,
     source_assignment_id, destination_assignment_id, amount_usd, note,
     status, requested_by)
  values
    (p_organization_id, v_check.client_id, p_source, p_destination,
     v_check.source_assignment_id, v_check.destination_assignment_id,
     round(p_amount, 2), nullif(btrim(coalesce(p_note, '')), ''),
     'PENDING_PLATFORM_REVIEW', p_actor)
  returning id, transfer_number into v_id, v_number;

  if p_execute then
    return public.apply_credit_transfer(v_id, p_actor);
  end if;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, new_values, organization_id)
  values
    (p_actor, 'CREDIT_TRANSFER_REQUESTED', 'CREDIT_TRANSFER', v_id::text,
     jsonb_build_object('transfer_number', v_number, 'amount_usd', round(p_amount, 2),
                        'source_account_id', p_source, 'destination_account_id', p_destination),
     p_organization_id);

  return jsonb_build_object('id', v_id, 'transfer_number', v_number, 'status', 'PENDING_PLATFORM_REVIEW');
end;
$$;

revoke all on function public.credit_transfer_validate(uuid, uuid, uuid, numeric, uuid) from public, anon, authenticated;
grant execute on function public.credit_transfer_validate(uuid, uuid, uuid, numeric, uuid) to service_role;
revoke all on function public.apply_credit_transfer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_credit_transfer(uuid, uuid) to service_role;
revoke all on function public.create_credit_transfer(uuid, uuid, uuid, numeric, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.create_credit_transfer(uuid, uuid, uuid, numeric, text, uuid, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- reset_all_data(): same as 000032 plus credit_transfers (before the
-- assignments and accounts it references).
-- ----------------------------------------------------------------------------
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
  delete from public.credit_transfers where organization_id = p_organization_id;
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

  -- NOTE: the document-code sequences are shared across ALL organizations and
  -- are deliberately NOT reset here — see 000032's header note.
end;
$$;

revoke all on function public.reset_all_data(uuid) from public, anon, authenticated;
grant execute on function public.reset_all_data(uuid) to service_role;
