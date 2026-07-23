-- ============================================================================
-- Rush Tracker — Phase 4: Ledger accounting, adjustments, reversals.
--
-- The ledger (created in Phase 3) is the financial source of truth (spec §35):
--   current due = sum(debit_bdt) - sum(credit_bdt).
-- Approved financial records are never edited/deleted — corrections happen via
-- adjustments or reversals, each of which only ADDS ledger rows (spec §39–41).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Adjustments (spec §40)
-- ----------------------------------------------------------------------------
create type public.adjustment_type as enum ('ADD_DUE', 'REDUCE_DUE', 'REVERSAL');

create sequence if not exists public.adjustment_seq;

create table public.adjustments (
  id                uuid primary key default gen_random_uuid(),
  adjustment_number text not null unique
                      default ('ADJ-' || lpad(nextval('public.adjustment_seq')::text, 6, '0')),
  client_id         uuid not null references public.clients (id),
  type              public.adjustment_type not null,
  amount_bdt        numeric(18, 2) not null check (amount_bdt > 0),
  reference_type    text,
  reference_id      text,
  ledger_entry_id   uuid references public.ledger_entries (id),
  reason            text not null,
  internal_note     text,
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now()
);

create index idx_adjustments_client on public.adjustments (client_id);
create index idx_adjustments_created on public.adjustments (created_at desc);

-- ----------------------------------------------------------------------------
-- Aggregates (read-only; the ledger is authoritative — spec §35).
-- ----------------------------------------------------------------------------
create or replace function public.client_financials(p_client_id uuid)
returns table (
  total_debit        numeric,
  total_credit       numeric,
  current_due        numeric,
  total_approved_usd numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(debit_bdt), 0),
    coalesce(sum(credit_bdt), 0),
    coalesce(sum(debit_bdt), 0) - coalesce(sum(credit_bdt), 0),
    coalesce(sum(usd_amount) filter (where type = 'LIMIT_APPROVAL'), 0)
  from public.ledger_entries
  where client_id = p_client_id;
$$;

create or replace function public.total_outstanding_due()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(debit_bdt), 0) - coalesce(sum(credit_bdt), 0)
  from public.ledger_entries;
$$;

-- ----------------------------------------------------------------------------
-- create_adjustment (spec §40) — atomic: one ledger row + one adjustment row.
--   ADD_DUE    -> ADJUSTMENT_DEBIT  (increases due)
--   REDUCE_DUE -> ADJUSTMENT_CREDIT (decreases due)
-- ----------------------------------------------------------------------------
create or replace function public.create_adjustment(
  p_client_id     uuid,
  p_type          text,
  p_amount        numeric,
  p_reason        text,
  p_internal_note text,
  p_actor         uuid
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
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required';
  end if;

  perform 1 from public.clients where id = p_client_id;
  if not found then raise exception 'Client not found'; end if;

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
    (client_id, type, reference_type, bdt_amount, debit_bdt, credit_bdt, description, created_by)
  values
    (p_client_id, v_led_type, 'ADJUSTMENT', p_amount, v_debit, v_credit, p_reason, p_actor)
  returning id into v_ledger_id;

  insert into public.adjustments
    (client_id, type, amount_bdt, reference_type, reference_id, ledger_entry_id,
     reason, internal_note, created_by)
  values
    (p_client_id, p_type::public.adjustment_type, p_amount, 'LEDGER_ENTRY',
     v_ledger_id::text, v_ledger_id, p_reason, p_internal_note, p_actor)
  returning id into v_adj_id;

  update public.ledger_entries
    set reference_id = v_adj_id::text
    where id = v_ledger_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, new_values)
  values
    (p_actor, 'ADJUSTMENT_CREATED', 'ADJUSTMENT', v_adj_id::text,
     jsonb_build_object('client_id', p_client_id, 'type', p_type, 'amount_bdt', p_amount));

  return v_adj_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- reverse_financial_transaction (spec §41). Never deletes the original; adds
-- an opposite REVERSAL ledger row. Prevents duplicate reversal.
-- ----------------------------------------------------------------------------
create or replace function public.reverse_financial_transaction(
  p_ledger_id uuid,
  p_reason    text,
  p_actor     uuid
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

  -- Opposite effect: swap debit/credit.
  insert into public.ledger_entries
    (client_id, type, reference_type, reference_id, usd_amount, usd_rate,
     bdt_amount, debit_bdt, credit_bdt, description, created_by)
  values
    (v_orig.client_id, 'REVERSAL', 'LEDGER_ENTRY', p_ledger_id::text,
     v_orig.usd_amount, v_orig.usd_rate, v_amount,
     v_orig.credit_bdt, v_orig.debit_bdt,
     'Reversal of ' || v_orig.transaction_number || ': ' || p_reason, p_actor)
  returning id into v_new_id;

  insert into public.adjustments
    (client_id, type, amount_bdt, reference_type, reference_id, ledger_entry_id,
     reason, created_by)
  values
    (v_orig.client_id, 'REVERSAL', v_amount, 'LEDGER_ENTRY', p_ledger_id::text,
     v_new_id, p_reason, p_actor);

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values)
  values
    (p_actor, 'REVERSAL_CREATED', 'LEDGER_ENTRY', p_ledger_id::text,
     jsonb_build_object(
       'original_transaction', v_orig.transaction_number,
       'original_type', v_orig.type
     ),
     jsonb_build_object('reversal_ledger_id', v_new_id, 'amount_bdt', v_amount, 'reason', p_reason));

  return v_new_id;
end;
$$;

revoke all on function public.create_adjustment(uuid, text, numeric, text, text, uuid) from public;
revoke all on function public.reverse_financial_transaction(uuid, text, uuid) from public;
revoke all on function public.client_financials(uuid) from public;
revoke all on function public.total_outstanding_due() from public;
grant execute on function public.create_adjustment(uuid, text, numeric, text, text, uuid) to service_role;
grant execute on function public.reverse_financial_transaction(uuid, text, uuid) to service_role;
grant execute on function public.client_financials(uuid) to service_role;
grant execute on function public.total_outstanding_due() to service_role;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.adjustments enable row level security;

-- Admins with adjustments.view. Clients see the financial effect through their
-- ledger/statement (internal notes stay admin-only).
create policy adjustments_select on public.adjustments
  for select to authenticated
  using (public.is_admin() and public.has_permission('adjustments.view'));
