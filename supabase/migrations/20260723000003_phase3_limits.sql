-- ============================================================================
-- Rush Tracker — Phase 3: Limit Requests, Exchange Rates, Ledger, Attachments.
--
-- The limit-approval transaction is the first thing that creates client due
-- (spec §28, §31). It is atomic: request → APPROVED, ad account current limit
-- updated, and a LIMIT_APPROVAL ledger debit written, all in one RPC.
-- The ledger UI, adjustments and reversals arrive in Phase 4; the ledger table
-- and the approval debit live here because approval must record billing
-- atomically.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type public.limit_request_status as enum (
  'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'
);
create type public.ledger_entry_type as enum (
  'LIMIT_APPROVAL', 'PAYMENT', 'ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT', 'REVERSAL'
);

-- ----------------------------------------------------------------------------
-- Sequences for human-readable numbers
-- ----------------------------------------------------------------------------
create sequence if not exists public.limit_request_seq;
create sequence if not exists public.ledger_txn_seq;

-- ----------------------------------------------------------------------------
-- Exchange rates (spec §27). Current default = latest row by effective_from.
-- ----------------------------------------------------------------------------
create table public.exchange_rates (
  id             uuid primary key default gen_random_uuid(),
  rate           numeric(18, 4) not null check (rate > 0),
  effective_from timestamptz not null default now(),
  changed_by     uuid references auth.users (id),
  created_at     timestamptz not null default now()
);

create index idx_exchange_rates_effective on public.exchange_rates (effective_from desc);

-- Seed the initial default rate (spec example ৳145).
insert into public.exchange_rates (rate, effective_from) values (145.0000, now());

create or replace function public.current_usd_rate()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select rate
  from public.exchange_rates
  where effective_from <= now()
  order by effective_from desc
  limit 1;
$$;

-- ----------------------------------------------------------------------------
-- Limit requests (spec §22)
-- ----------------------------------------------------------------------------
create table public.limit_requests (
  id                    uuid primary key default gen_random_uuid(),
  request_number        text not null unique
                          default ('LR-' || lpad(nextval('public.limit_request_seq')::text, 6, '0')),

  client_id             uuid not null references public.clients (id),
  ad_account_id         uuid not null references public.ad_accounts (id),
  assignment_id         uuid not null references public.ad_account_assignments (id),

  opening_balance_usd   numeric(18, 2) not null check (opening_balance_usd >= 0),
  requested_amount_usd  numeric(18, 2) not null check (requested_amount_usd > 0),
  approved_amount_usd   numeric(18, 2) check (approved_amount_usd > 0),

  default_usd_rate      numeric(18, 4) not null,
  approved_usd_rate     numeric(18, 4) check (approved_usd_rate > 0),

  expected_new_limit_usd numeric(18, 2) not null,
  approved_new_limit_usd numeric(18, 2),

  bdt_charge            numeric(18, 2),

  status                public.limit_request_status not null default 'PENDING',

  requested_by          uuid references auth.users (id),
  reviewed_by           uuid references auth.users (id),

  requested_at          timestamptz not null default now(),
  reviewed_at           timestamptz,
  approved_at           timestamptz,
  rejected_at           timestamptz,
  cancelled_at          timestamptz,

  admin_note            text,
  rejection_reason      text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- At most one PENDING request per ad account (spec §24, Rule).
create unique index uniq_pending_request_per_account
  on public.limit_requests (ad_account_id)
  where status = 'PENDING';

create index idx_limit_requests_client on public.limit_requests (client_id);
create index idx_limit_requests_account on public.limit_requests (ad_account_id);
create index idx_limit_requests_assignment on public.limit_requests (assignment_id);
create index idx_limit_requests_status on public.limit_requests (status);
create index idx_limit_requests_created on public.limit_requests (created_at desc);

create trigger trg_limit_requests_updated_at
  before update on public.limit_requests
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Ledger entries (spec §36) — append-only financial source of truth.
-- ----------------------------------------------------------------------------
create table public.ledger_entries (
  id                 uuid primary key default gen_random_uuid(),
  transaction_number text not null unique
                       default ('TXN-' || lpad(nextval('public.ledger_txn_seq')::text, 6, '0')),

  client_id          uuid not null references public.clients (id),

  type               public.ledger_entry_type not null,

  reference_type     text,
  reference_id       text,

  usd_amount         numeric(18, 2),
  usd_rate           numeric(18, 4),
  bdt_amount         numeric(18, 2),

  debit_bdt          numeric(18, 2) not null default 0 check (debit_bdt >= 0),
  credit_bdt         numeric(18, 2) not null default 0 check (credit_bdt >= 0),

  description        text,

  created_by         uuid references auth.users (id),
  created_at         timestamptz not null default now()
);

create index idx_ledger_client on public.ledger_entries (client_id);
create index idx_ledger_created on public.ledger_entries (created_at desc);
create index idx_ledger_type on public.ledger_entries (type);

-- ----------------------------------------------------------------------------
-- Attachments (spec §51) — proof metadata; files live in Supabase Storage.
-- ----------------------------------------------------------------------------
create table public.attachments (
  id                 uuid primary key default gen_random_uuid(),
  entity_type        text not null,
  entity_id          text not null,
  storage_bucket     text not null,
  storage_path       text not null,
  original_file_name text,
  mime_type          text,
  file_size          integer,
  uploaded_by        uuid references auth.users (id),
  created_at         timestamptz not null default now()
);

create index idx_attachments_entity on public.attachments (entity_type, entity_id);

-- Private storage bucket for all proof files (spec §50, §52).
insert into storage.buckets (id, name, public)
values ('proofs', 'proofs', false)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- Atomic limit approval (spec §28, §30, §31). SECURITY DEFINER + row locking;
-- execute granted to service_role only.
-- ----------------------------------------------------------------------------
create or replace function public.approve_limit_request(
  p_request_id      uuid,
  p_approved_amount numeric,
  p_approved_rate   numeric,
  p_actor           uuid,
  p_admin_note      text default null
)
returns uuid
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
     usd_amount, usd_rate, bdt_amount, debit_bdt, credit_bdt, description, created_by)
  values
    (v_req.client_id, 'LIMIT_APPROVAL', 'LIMIT_REQUEST', p_request_id::text,
     p_approved_amount, p_approved_rate, v_charge, v_charge, 0,
     'Limit approval ' || v_req.request_number, p_actor)
  returning id into v_ledger_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values)
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
       'ledger_id', v_ledger_id
     ));

  return v_ledger_id;
end;
$$;

-- Rebase a pending request's baseline to the account's current limit (spec §30).
create or replace function public.rebase_limit_request(
  p_request_id uuid,
  p_actor      uuid
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
  if v_req.status <> 'PENDING' then raise exception 'Request is not pending'; end if;

  select * into v_account from public.ad_accounts where id = v_req.ad_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;

  v_new_expected := v_account.current_limit_usd + v_req.requested_amount_usd;

  update public.limit_requests
    set opening_balance_usd    = v_account.current_limit_usd,
        expected_new_limit_usd = v_new_expected
    where id = p_request_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values)
  values
    (p_actor, 'LIMIT_REQUEST_REBASED', 'LIMIT_REQUEST', p_request_id::text,
     jsonb_build_object('opening_balance_usd', v_req.opening_balance_usd),
     jsonb_build_object(
       'opening_balance_usd', v_account.current_limit_usd,
       'expected_new_limit_usd', v_new_expected
     ));
end;
$$;

revoke all on function public.approve_limit_request(uuid, numeric, numeric, uuid, text) from public;
revoke all on function public.rebase_limit_request(uuid, uuid) from public;
grant execute on function public.approve_limit_request(uuid, numeric, numeric, uuid, text) to service_role;
grant execute on function public.rebase_limit_request(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Row Level Security (SELECT-only for browser; writes via server)
-- ----------------------------------------------------------------------------
alter table public.exchange_rates enable row level security;
alter table public.limit_requests enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.attachments enable row level security;

create policy exchange_rates_select on public.exchange_rates
  for select to authenticated using (public.is_admin());

create policy limit_requests_select on public.limit_requests
  for select to authenticated
  using (public.is_admin() or public.is_client_member(client_id));

create policy ledger_select on public.ledger_entries
  for select to authenticated
  using (
    (public.is_admin() and public.has_permission('ledger.view'))
    or public.is_client_member(client_id)
  );

-- Proof metadata is only ever read server-side (service role) to mint signed
-- URLs; admins may also read directly. Clients never query this table.
create policy attachments_select on public.attachments
  for select to authenticated using (public.is_admin());
