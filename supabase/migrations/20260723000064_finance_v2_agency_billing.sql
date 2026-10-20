-- ============================================================================
-- Finance v2, Milestone 4 — agency billing, payments, advances, periods.
-- docs/ACCOUNTING_POLICY.md §5, §7, §10.
--
-- Owner decisions (2026-10-21):
--   * Bill each approval: every limit request approved on a PLATFORM POOL
--     account becomes what that agency owes — approved USD × the agency's USD
--     rate. Payments are recorded separately and never create revenue; money
--     paid beyond what is owed is an ADVANCE that later charges use up.
--   * xRush Agency (org zero, the owner's own) is billed like any agency.
--   * Billing starts at go-live: only approvals from now on are charged (the
--     trigger below exists from now). What an agency already owed is entered
--     once as an opening balance.
--
--   agency_usd_rates   effective-dated BDT-per-USD rate per agency (config;
--                      ON DELETE CASCADE with the agency).
--   agency_charges     one per approval (and one optional opening balance).
--                      PENDING_RATE until the agency has a rate in force.
--   agency_payments    BDT received from an agency, split at posting into what
--                      settled the receivable and what became an advance.
--   finance_periods    calendar months (Asia/Dhaka) closed against postings.
--   journal_lines.party_org_id  which agency a receivable / advance line is
--                      for, so both are per agency.
--
-- Charges and payments survive an agency's deletion (organization_id SET
-- NULL, name snapshotted), like usd_sales — the platform's revenue is history.
--
-- Journal (posted by triggers, as 000061):
--   approval charged      Dr 1300 Receivables (agency)   Cr 4000 Revenue
--   …advance applied      Dr 2300 Advances (agency)      Cr 1300 (agency)
--   payment               Dr 1010 Bank & cash            Cr 1300 up to what is owed
--                                                        Cr 2300 the rest
--   opening balance owed  Dr 1300 (agency)               Cr 3000 Opening equity
--   opening credit        Dr 3000                        Cr 2300 (agency)
--
-- Periods: journal_post / journal_reverse refuse an event dated in a CLOSED
-- month (PERIOD_CLOSED). Corrections post into the open month (reversals are
-- dated when made). Only a month that has ended can be closed, and not while
-- it holds charges still waiting for a rate. Reopening needs a reason.
--
-- The approval trigger can never block an approval: billing runs in its own
-- sub-transaction and a failure is written to platform_finance_audit.
--
-- MANUAL ROLLBACK: drop the trigger on limit_requests, the new functions,
-- views and tables; restore journal_post / journal_reverse and the
-- journal_entries source_type check from 000061 / 000063; drop
-- journal_lines.party_org_id.
-- ============================================================================

-- ------------------------------------------------------- journal: parties ---
alter table public.journal_lines add column party_org_id uuid;
create index idx_journal_lines_party on public.journal_lines (account_code, party_org_id)
  where party_org_id is not null;
comment on column public.journal_lines.party_org_id is
  'The agency a receivable (1300) or advance (2300) line belongs to. No FK on purpose: the journal is history and must outlive the agency.';

alter table public.journal_entries drop constraint journal_entries_source_type_check;
alter table public.journal_entries add constraint journal_entries_source_type_check
  check (source_type in ('USD_PURCHASE', 'USD_OUTFLOW', 'USD_SALE', 'USD_SALE_RECEIPT', 'META_SPEND',
                         'AGENCY_CHARGE', 'AGENCY_ADVANCE_APPLIED', 'AGENCY_PAYMENT', 'MANUAL'));

-- ----------------------------------------------------------------- periods ---
create table public.finance_periods (
  month         date primary key check (extract(day from month) = 1),
  status        text not null check (status in ('OPEN', 'CLOSED')),
  closed_at     timestamptz,
  closed_by     uuid references auth.users (id),
  reopened_at   timestamptz,
  reopened_by   uuid references auth.users (id),
  reopen_reason text
);
alter table public.finance_periods enable row level security;
revoke all on public.finance_periods from anon, authenticated;

create or replace function public.finance_month_of(p_at timestamptz)
returns date
language sql
immutable
set search_path = public
as $$ select date_trunc('month', timezone('Asia/Dhaka', p_at))::date $$;

create or replace function public.finance_assert_period_open(p_at timestamptz)
returns void
language plpgsql
stable
set search_path = public
as $$
begin
  if exists (select 1 from public.finance_periods
             where month = public.finance_month_of(p_at) and status = 'CLOSED') then
    raise exception 'PERIOD_CLOSED: % is closed — date it in an open month, or reopen the month first',
      to_char(public.finance_month_of(p_at), 'FMMonth YYYY');
  end if;
end;
$$;

-- 000061's journal_post + period guard + per-line party.
create or replace function public.journal_post(
  p_source_type text,
  p_source_id   uuid,
  p_event_at    timestamptz,
  p_description text,
  p_actor       uuid,
  p_lines       jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_l  jsonb;
  v_n  integer := 0;
begin
  perform public.finance_assert_period_open(p_event_at);
  insert into public.journal_entries (event_at, source_type, source_id, description, created_by)
  values (p_event_at, p_source_type, p_source_id, p_description, p_actor)
  returning id into v_id;
  for v_l in select * from jsonb_array_elements(p_lines) loop
    if coalesce((v_l->>'debit')::numeric, 0) = 0 and coalesce((v_l->>'credit')::numeric, 0) = 0 then
      continue;
    end if;
    v_n := v_n + 1;
    insert into public.journal_lines (entry_id, line_no, account_code, debit_bdt, credit_bdt, usd_amount, memo, party_org_id)
    values (v_id, v_n, v_l->>'account', coalesce((v_l->>'debit')::numeric, 0),
            coalesce((v_l->>'credit')::numeric, 0), (v_l->>'usd')::numeric, v_l->>'memo',
            (v_l->>'party')::uuid);
  end loop;
  return v_id;
end;
$$;

-- 000061's journal_reverse + period guard + party copied.
create or replace function public.journal_reverse(
  p_source_type text,
  p_source_id   uuid,
  p_event_at    timestamptz,
  p_reason      text,
  p_actor       uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orig public.journal_entries;
  v_id   uuid;
begin
  perform public.finance_assert_period_open(p_event_at);
  select * into v_orig from public.journal_entries
    where source_type = p_source_type and source_id = p_source_id and not is_reversal;
  if not found then
    raise exception 'NOT_FOUND: no journal entry for % %', p_source_type, p_source_id;
  end if;
  insert into public.journal_entries (event_at, source_type, source_id, is_reversal, reversal_of, description, created_by)
  values (p_event_at, p_source_type, p_source_id, true, v_orig.id,
          'Reversal of ' || v_orig.entry_number || coalesce(': ' || nullif(btrim(p_reason), ''), ''), p_actor)
  returning id into v_id;
  insert into public.journal_lines (entry_id, line_no, account_code, debit_bdt, credit_bdt, usd_amount, memo, party_org_id)
  select v_id, line_no, account_code, credit_bdt, debit_bdt, usd_amount, memo, party_org_id
  from public.journal_lines where entry_id = v_orig.id;
  return v_id;
end;
$$;

-- Per agency, from the journal: owed (1300, debit side) and advance (2300,
-- credit side). Locked callers read this to split a payment or apply an
-- advance.
create or replace function public.agency_balance(p_org uuid, out owed_bdt numeric, out advance_bdt numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(debit_bdt - credit_bdt) filter (where account_code = '1300'), 0),
    coalesce(sum(credit_bdt - debit_bdt) filter (where account_code = '2300'), 0)
  from public.journal_lines
  where party_org_id = p_org and account_code in ('1300', '2300')
$$;

-- ------------------------------------------------------------------- rates ---
create table public.agency_usd_rates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  rate            numeric(18, 6) not null check (rate > 0),
  effective_from  date not null,
  note            text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  unique (organization_id, effective_from)
);
alter table public.agency_usd_rates enable row level security;
revoke all on public.agency_usd_rates from anon, authenticated;

create or replace function public.agency_rate_at(p_org uuid, p_at timestamptz)
returns numeric
language sql
stable
set search_path = public
as $$
  select rate from public.agency_usd_rates
  where organization_id = p_org
    and effective_from <= timezone('Asia/Dhaka', p_at)::date
  order by effective_from desc
  limit 1
$$;

-- ----------------------------------------------------------------- charges ---
create sequence public.agency_charge_seq;

create table public.agency_charges (
  id               uuid primary key default gen_random_uuid(),
  reference_id     text not null unique
                     default ('CHG-' || lpad(nextval('public.agency_charge_seq')::text, 6, '0')),
  organization_id  uuid references public.organizations (id) on delete set null,
  agency_name      text not null,
  kind             text not null check (kind in ('LIMIT_APPROVAL', 'OPENING_BALANCE')),
  limit_request_id uuid unique references public.limit_requests (id) on delete set null,
  ad_account_id    uuid references public.ad_accounts (id) on delete set null,
  usd_amount       numeric(24, 6) check (usd_amount is null or usd_amount > 0),
  rate             numeric(18, 6),
  -- Positive = the agency owes it. Only an opening balance may be negative
  -- (the agency starts with credit).
  bdt_amount       numeric(18, 2),
  event_at         timestamptz not null,
  status           text not null check (status in ('PENDING_RATE', 'POSTED', 'REVERSED')),
  posted_at        timestamptz,
  reversed_by      uuid references auth.users (id),
  reversed_at      timestamptz,
  reversal_reason  text,
  notes            text,
  created_by       uuid references auth.users (id),
  created_at       timestamptz not null default now(),
  check (status = 'PENDING_RATE' or bdt_amount is not null),
  check (kind = 'OPENING_BALANCE' or bdt_amount is null or bdt_amount > 0),
  check (kind <> 'OPENING_BALANCE' or bdt_amount <> 0),
  check (kind <> 'LIMIT_APPROVAL' or usd_amount is not null)
);
create index idx_agency_charges_org on public.agency_charges (organization_id, event_at desc);
create index idx_agency_charges_pending on public.agency_charges (organization_id) where status = 'PENDING_RATE';
-- One live opening balance per agency.
create unique index uq_agency_charges_opening
  on public.agency_charges (organization_id) where kind = 'OPENING_BALANCE' and status <> 'REVERSED';

-- ---------------------------------------------------------------- payments ---
create sequence public.agency_payment_seq;

create table public.agency_payments (
  id                 uuid primary key default gen_random_uuid(),
  reference_id       text not null unique
                       default ('APAY-' || lpad(nextval('public.agency_payment_seq')::text, 6, '0')),
  organization_id    uuid references public.organizations (id) on delete set null,
  agency_name        text not null,
  bdt_amount         numeric(18, 2) not null check (bdt_amount > 0),
  -- Fixed at posting: what settled the receivable, and what became an advance.
  applied_bdt        numeric(18, 2) not null check (applied_bdt >= 0),
  advance_bdt        numeric(18, 2) not null check (advance_bdt >= 0),
  method             text,
  external_reference text,
  is_internal        boolean not null default false,
  received_at        timestamptz not null,
  idempotency_key    text unique,
  status             text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversed_by        uuid references auth.users (id),
  reversed_at        timestamptz,
  reversal_reason    text,
  notes              text,
  recorded_by        uuid references auth.users (id),
  created_at         timestamptz not null default now(),
  check (applied_bdt + advance_bdt = bdt_amount)
);
create index idx_agency_payments_org on public.agency_payments (organization_id, received_at desc);

create trigger trg_agency_charges_no_delete
  before delete on public.agency_charges
  for each row execute function public.finance_block_mutation();
create trigger trg_agency_payments_no_delete
  before delete on public.agency_payments
  for each row execute function public.finance_block_mutation();

alter table public.agency_charges  enable row level security;
alter table public.agency_payments enable row level security;
revoke all on public.agency_charges, public.agency_payments from anon, authenticated;
revoke all on sequence public.agency_charge_seq, public.agency_payment_seq from anon, authenticated;

-- ------------------------------------------------------- posting (journal) ---
create or replace function public.journal_post_agency_charge(c public.agency_charges)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bal   record;
  v_apply numeric;
begin
  if c.kind = 'OPENING_BALANCE' then
    perform public.journal_post('AGENCY_CHARGE', c.id, c.event_at,
      c.reference_id || ' — opening balance, ' || c.agency_name, c.created_by,
      case when c.bdt_amount > 0 then jsonb_build_array(
        jsonb_build_object('account', '1300', 'debit', c.bdt_amount, 'party', c.organization_id, 'memo', 'Owed before Finance v2'),
        jsonb_build_object('account', '3000', 'credit', c.bdt_amount))
      else jsonb_build_array(
        jsonb_build_object('account', '3000', 'debit', -c.bdt_amount),
        jsonb_build_object('account', '2300', 'credit', -c.bdt_amount, 'party', c.organization_id, 'memo', 'Credit before Finance v2'))
      end);
    return;
  end if;

  perform public.journal_post('AGENCY_CHARGE', c.id, c.event_at,
    c.reference_id || ' — ' || c.agency_name || ', ' || to_char(c.usd_amount, 'FM999999990.00') || ' USD @ ' || to_char(c.rate, 'FM9990.00####'),
    c.created_by,
    jsonb_build_array(
      jsonb_build_object('account', '1300', 'debit', c.bdt_amount, 'party', c.organization_id),
      jsonb_build_object('account', '4000', 'credit', c.bdt_amount, 'usd', c.usd_amount)));

  -- Money the agency paid ahead covers this charge first.
  select * into v_bal from public.agency_balance(c.organization_id);
  v_apply := least(greatest(v_bal.advance_bdt, 0), c.bdt_amount);
  if v_apply > 0 then
    perform public.journal_post('AGENCY_ADVANCE_APPLIED', c.id, c.event_at,
      c.reference_id || ' — paid from ' || c.agency_name || '''s advance', c.created_by,
      jsonb_build_array(
        jsonb_build_object('account', '2300', 'debit', v_apply, 'party', c.organization_id),
        jsonb_build_object('account', '1300', 'credit', v_apply, 'party', c.organization_id)));
  end if;
end;
$$;

create or replace function public.trg_agency_charge_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'POSTED' and (tg_op = 'INSERT' or old.status = 'PENDING_RATE') then
    perform public.journal_post_agency_charge(new);
  elsif tg_op = 'UPDATE' and new.status = 'REVERSED' and old.status = 'POSTED' then
    perform public.journal_reverse('AGENCY_CHARGE', new.id, new.reversed_at, new.reversal_reason, new.reversed_by);
    if exists (select 1 from public.journal_entries
               where source_type = 'AGENCY_ADVANCE_APPLIED' and source_id = new.id and not is_reversal) then
      perform public.journal_reverse('AGENCY_ADVANCE_APPLIED', new.id, new.reversed_at, new.reversal_reason, new.reversed_by);
    end if;
  end if;
  return null;
end;
$$;
create trigger trg_agency_charges_journal
  after insert or update of status on public.agency_charges
  for each row execute function public.trg_agency_charge_journal();

create or replace function public.trg_agency_payment_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.journal_post('AGENCY_PAYMENT', new.id, new.received_at,
      new.reference_id || ' — payment from ' || new.agency_name || case when new.is_internal then ' (internal)' else '' end,
      new.recorded_by,
      jsonb_build_array(
        jsonb_build_object('account', '1010', 'debit', new.bdt_amount),
        jsonb_build_object('account', '1300', 'credit', new.applied_bdt, 'party', new.organization_id),
        jsonb_build_object('account', '2300', 'credit', new.advance_bdt, 'party', new.organization_id, 'memo', 'Paid ahead')));
  elsif new.status = 'REVERSED' and old.status = 'POSTED' then
    perform public.journal_reverse('AGENCY_PAYMENT', new.id, new.reversed_at, new.reversal_reason, new.reversed_by);
  end if;
  return null;
end;
$$;
create trigger trg_agency_payments_journal
  after insert or update of status on public.agency_payments
  for each row execute function public.trg_agency_payment_journal();

-- --------------------------------------------------------- billing hooks ---
-- Price and record the charge for one approved pool-account limit request.
-- Idempotent (one charge per request).
create or replace function public.agency_charge_for_limit_request(p_request uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lr   public.limit_requests;
  v_name text;
  v_rate numeric;
  v_at   timestamptz;
begin
  select * into v_lr from public.limit_requests where id = p_request;
  if not found or v_lr.status <> 'APPROVED' or v_lr.approved_amount_usd is null or v_lr.approved_amount_usd <= 0 then
    return;
  end if;
  if not exists (select 1 from public.ad_accounts where id = v_lr.ad_account_id and is_platform) then
    return; -- an agency's own account: the platform sold nothing
  end if;
  select name into v_name from public.organizations where id = v_lr.organization_id;
  v_at := coalesce(v_lr.approved_at, now());
  v_rate := public.agency_rate_at(v_lr.organization_id, v_at);

  perform public.finance_v2_lock();
  insert into public.agency_charges (
    organization_id, agency_name, kind, limit_request_id, ad_account_id, usd_amount,
    rate, bdt_amount, event_at, status, posted_at, created_by, notes)
  values (
    v_lr.organization_id, coalesce(v_name, 'Agency'), 'LIMIT_APPROVAL', v_lr.id, v_lr.ad_account_id,
    v_lr.approved_amount_usd, v_rate,
    case when v_rate is null then null else round(v_lr.approved_amount_usd * v_rate, 2) end,
    v_at, case when v_rate is null then 'PENDING_RATE' else 'POSTED' end,
    case when v_rate is null then null else now() end,
    v_lr.reviewed_by, v_lr.request_number)
  on conflict (limit_request_id) do nothing;
end;
$$;

create or replace function public.trg_limit_request_agency_charge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'APPROVED' and old.status is distinct from 'APPROVED' then
    -- Billing must never block an approval: own sub-transaction, failure logged.
    begin
      perform public.agency_charge_for_limit_request(new.id);
    exception when others then
      insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
      values (new.reviewed_by, 'AGENCY_CHARGE_FAILED', 'LIMIT_REQUEST', new.id,
              jsonb_build_object('error', sqlerrm, 'request_number', new.request_number));
    end;
  end if;
  return null;
end;
$$;
create trigger trg_limit_requests_agency_charge
  after update of status on public.limit_requests
  for each row execute function public.trg_limit_request_agency_charge();

-- ------------------------------------------------------------------- RPCs ---
-- A new rate for an agency from a date; then price any of its charges that
-- were waiting and now have a rate in force.
create or replace function public.set_agency_rate(
  p_actor uuid, p_org uuid, p_rate numeric, p_from date, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c        record;
  v_rate   numeric;
  v_priced integer := 0;
begin
  perform public.finance_v2_lock();
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'NOT_FOUND: Agency not found';
  end if;
  if p_rate is null or p_rate <= 0 then raise exception 'INVALID_AMOUNT: Enter a rate above zero'; end if;
  if p_from is null then raise exception 'INVALID_DATE: Enter the date the rate starts'; end if;
  begin
    insert into public.agency_usd_rates (organization_id, rate, effective_from, note, created_by)
    values (p_org, round(p_rate, 6), p_from, nullif(btrim(coalesce(p_note, '')), ''), p_actor);
  exception when unique_violation then
    raise exception 'DUPLICATE: This agency already has a rate starting %', p_from;
  end;

  for c in select * from public.agency_charges
           where organization_id = p_org and status = 'PENDING_RATE' order by event_at
  loop
    v_rate := public.agency_rate_at(p_org, c.event_at);
    continue when v_rate is null;
    update public.agency_charges
    set rate = v_rate, bdt_amount = round(c.usd_amount * v_rate, 2), status = 'POSTED', posted_at = now()
    where id = c.id;
    v_priced := v_priced + 1;
  end loop;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_RATE_SET', 'ORGANIZATION', p_org,
          jsonb_build_object('rate', p_rate, 'from', p_from, 'priced', v_priced));
  return jsonb_build_object('priced', v_priced);
end;
$$;

create or replace function public.record_agency_payment(
  p_actor uuid, p_org uuid, p_bdt numeric, p_received_at timestamptz, p_method text,
  p_is_internal boolean, p_reference text, p_notes text, p_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.agency_payments;
  v_row      public.agency_payments;
  v_name     text;
  v_bal      record;
  v_applied  numeric;
  v_key      text := nullif(btrim(coalesce(p_key, '')), '');
begin
  perform public.finance_v2_lock();
  if v_key is not null then
    select * into v_existing from public.agency_payments where idempotency_key = v_key;
    if found then return to_jsonb(v_existing) || jsonb_build_object('duplicate', true); end if;
  end if;
  select name into v_name from public.organizations where id = p_org;
  if not found then raise exception 'NOT_FOUND: Agency not found'; end if;
  if p_bdt is null or p_bdt <= 0 or p_bdt <> round(p_bdt, 2) then
    raise exception 'INVALID_AMOUNT: Enter the BDT received, to the paisa';
  end if;
  if p_received_at is null then raise exception 'INVALID_DATE: Enter when it was received'; end if;

  select * into v_bal from public.agency_balance(p_org);
  v_applied := least(greatest(v_bal.owed_bdt, 0), p_bdt);

  insert into public.agency_payments (
    organization_id, agency_name, bdt_amount, applied_bdt, advance_bdt, method, external_reference,
    is_internal, received_at, idempotency_key, notes, recorded_by)
  values (p_org, v_name, p_bdt, v_applied, p_bdt - v_applied, nullif(btrim(coalesce(p_method, '')), ''),
          nullif(btrim(coalesce(p_reference, '')), ''), coalesce(p_is_internal, false), p_received_at, v_key,
          nullif(btrim(coalesce(p_notes, '')), ''), p_actor)
  returning * into v_row;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_PAYMENT_RECORDED', 'AGENCY_PAYMENT', v_row.id, jsonb_build_object(
    'organization_id', p_org, 'bdt', p_bdt, 'applied', v_applied, 'advance', p_bdt - v_applied));
  return to_jsonb(v_row) || jsonb_build_object('duplicate', false);
end;
$$;

create or replace function public.record_agency_opening_balance(
  p_actor uuid, p_org uuid, p_bdt numeric, p_as_of timestamptz, p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_row  public.agency_charges;
begin
  perform public.finance_v2_lock();
  select name into v_name from public.organizations where id = p_org;
  if not found then raise exception 'NOT_FOUND: Agency not found'; end if;
  if p_bdt is null or p_bdt = 0 or p_bdt <> round(p_bdt, 2) then
    raise exception 'INVALID_AMOUNT: Enter the opening balance in BDT (negative if the agency has credit with you)';
  end if;
  if nullif(btrim(coalesce(p_notes, '')), '') is null then
    raise exception 'NOTE_REQUIRED: Say where the figure comes from';
  end if;
  begin
    insert into public.agency_charges (organization_id, agency_name, kind, bdt_amount, event_at, status, posted_at, notes, created_by)
    values (p_org, v_name, 'OPENING_BALANCE', p_bdt, p_as_of, 'POSTED', now(), btrim(p_notes), p_actor)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'DUPLICATE: This agency already has an opening balance — reverse it first to change it';
  end;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_OPENING_BALANCE', 'AGENCY_CHARGE', v_row.id, jsonb_build_object('organization_id', p_org, 'bdt', p_bdt));
  return to_jsonb(v_row);
end;
$$;

create or replace function public.reverse_agency_charge(p_actor uuid, p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.agency_charges;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Give a reason for the reversal';
  end if;
  select * into v_row from public.agency_charges where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Charge not found'; end if;
  if v_row.status = 'REVERSED' then raise exception 'ALREADY_REVERSED: This charge is already reversed'; end if;
  update public.agency_charges
  set status = 'REVERSED', reversed_by = p_actor, reversed_at = now(), reversal_reason = btrim(p_reason)
  where id = p_id
  returning * into v_row;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_CHARGE_REVERSED', 'AGENCY_CHARGE', p_id, jsonb_build_object('reason', btrim(p_reason)));
  return to_jsonb(v_row);
end;
$$;

-- A payment can be undone only while the advance it created is still unused;
-- otherwise the agency's later charges would lose what paid them.
create or replace function public.reverse_agency_payment(p_actor uuid, p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.agency_payments;
  v_bal record;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Give a reason for the reversal';
  end if;
  select * into v_row from public.agency_payments where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Payment not found'; end if;
  if v_row.status <> 'POSTED' then raise exception 'ALREADY_REVERSED: This payment is already reversed'; end if;
  select * into v_bal from public.agency_balance(v_row.organization_id);
  if v_row.advance_bdt > 0 and v_bal.advance_bdt < v_row.advance_bdt then
    raise exception 'PAYMENT_APPLIED: % BDT of this payment''s advance has already paid later charges; reverse those first',
      round(v_row.advance_bdt - v_bal.advance_bdt, 2);
  end if;
  update public.agency_payments
  set status = 'REVERSED', reversed_by = p_actor, reversed_at = now(), reversal_reason = btrim(p_reason)
  where id = p_id
  returning * into v_row;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_PAYMENT_REVERSED', 'AGENCY_PAYMENT', p_id, jsonb_build_object('reason', btrim(p_reason)));
  return to_jsonb(v_row);
end;
$$;

create or replace function public.close_finance_period(p_actor uuid, p_month date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_pending integer;
begin
  perform public.finance_v2_lock();
  if v_month >= public.finance_month_of(now()) then
    raise exception 'PERIOD_NOT_OVER: Only a month that has ended can be closed';
  end if;
  select count(*) into v_pending from public.agency_charges
  where status = 'PENDING_RATE' and public.finance_month_of(event_at) = v_month;
  if v_pending > 0 then
    raise exception 'UNPRICED_CHARGES: % charge(s) in this month still need an agency rate', v_pending;
  end if;
  insert into public.finance_periods (month, status, closed_at, closed_by)
  values (v_month, 'CLOSED', now(), p_actor)
  on conflict (month) do update
    set status = 'CLOSED', closed_at = now(), closed_by = p_actor
    where public.finance_periods.status = 'OPEN';
  insert into public.platform_finance_audit (actor_id, action, entity_type, new_values)
  values (p_actor, 'FINANCE_PERIOD_CLOSED', 'FINANCE_PERIOD', jsonb_build_object('month', v_month));
  return jsonb_build_object('month', v_month, 'status', 'CLOSED');
end;
$$;

create or replace function public.reopen_finance_period(p_actor uuid, p_month date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Say why the month is being reopened';
  end if;
  update public.finance_periods
  set status = 'OPEN', reopened_at = now(), reopened_by = p_actor, reopen_reason = btrim(p_reason)
  where month = v_month and status = 'CLOSED';
  if not found then raise exception 'NOT_FOUND: That month is not closed'; end if;
  insert into public.platform_finance_audit (actor_id, action, entity_type, new_values)
  values (p_actor, 'FINANCE_PERIOD_REOPENED', 'FINANCE_PERIOD', jsonb_build_object('month', v_month, 'reason', btrim(p_reason)));
  return jsonb_build_object('month', v_month, 'status', 'OPEN');
end;
$$;

-- ------------------------------------------------------------------- views ---
create view public.agency_billing_summary
  with (security_invoker = true) as
select
  o.id   as organization_id,
  o.name,
  o.subscription_status,
  (select rate from public.agency_usd_rates r
   where r.organization_id = o.id and r.effective_from <= timezone('Asia/Dhaka', now())::date
   order by effective_from desc limit 1)                                                     as current_rate,
  coalesce((select sum(usd_amount) from public.agency_charges c
            where c.organization_id = o.id and c.kind = 'LIMIT_APPROVAL' and c.status = 'POSTED'), 0) as billed_usd,
  coalesce((select sum(bdt_amount) from public.agency_charges c
            where c.organization_id = o.id and c.kind = 'LIMIT_APPROVAL' and c.status = 'POSTED'), 0) as billed_bdt,
  coalesce((select sum(bdt_amount) from public.agency_payments p
            where p.organization_id = o.id and p.status = 'POSTED'), 0)                      as paid_bdt,
  (select count(*) from public.agency_charges c
   where c.organization_id = o.id and c.status = 'PENDING_RATE')                             as pending_rate,
  coalesce((select sum(usd_amount) from public.agency_charges c
            where c.organization_id = o.id and c.status = 'PENDING_RATE'), 0)                as pending_usd,
  b.owed_bdt,
  b.advance_bdt
from public.organizations o
cross join lateral public.agency_balance(o.id) b;

revoke all on public.agency_billing_summary from anon, authenticated;

-- ----------------------------------------------------------------- grants ---
revoke all on function public.finance_month_of(timestamptz) from public, anon, authenticated;
revoke all on function public.finance_assert_period_open(timestamptz) from public, anon, authenticated;
revoke all on function public.journal_post(text, uuid, timestamptz, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.journal_reverse(text, uuid, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function public.agency_balance(uuid) from public, anon, authenticated;
grant execute on function public.agency_balance(uuid) to service_role;
revoke all on function public.agency_rate_at(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.journal_post_agency_charge(public.agency_charges) from public, anon, authenticated;
revoke all on function public.trg_agency_charge_journal() from public, anon, authenticated;
revoke all on function public.trg_agency_payment_journal() from public, anon, authenticated;
revoke all on function public.agency_charge_for_limit_request(uuid) from public, anon, authenticated;
revoke all on function public.trg_limit_request_agency_charge() from public, anon, authenticated;
revoke all on function public.set_agency_rate(uuid, uuid, numeric, date, text) from public, anon, authenticated;
grant execute on function public.set_agency_rate(uuid, uuid, numeric, date, text) to service_role;
revoke all on function public.record_agency_payment(uuid, uuid, numeric, timestamptz, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.record_agency_payment(uuid, uuid, numeric, timestamptz, text, boolean, text, text, text) to service_role;
revoke all on function public.record_agency_opening_balance(uuid, uuid, numeric, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_agency_opening_balance(uuid, uuid, numeric, timestamptz, text) to service_role;
revoke all on function public.reverse_agency_charge(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_agency_charge(uuid, uuid, text) to service_role;
revoke all on function public.reverse_agency_payment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_agency_payment(uuid, uuid, text) to service_role;
revoke all on function public.close_finance_period(uuid, date) from public, anon, authenticated;
grant execute on function public.close_finance_period(uuid, date) to service_role;
revoke all on function public.reopen_finance_period(uuid, date, text) from public, anon, authenticated;
grant execute on function public.reopen_finance_period(uuid, date, text) to service_role;
