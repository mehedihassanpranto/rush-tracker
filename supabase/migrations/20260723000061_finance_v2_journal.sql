-- ============================================================================
-- Finance v2, Milestone 2 — double-entry journal for the PLATFORM's book.
-- docs/ACCOUNTING_POLICY.md ("Posting map"), docs/FINANCE_V2_MILESTONE0.md.
--
--   gl_accounts       the platform's chart of accounts (seeded below)
--   journal_entries   one per posted event, one more per reversal
--   journal_lines     debit OR credit in BDT, plus an optional USD memo
--
-- BDT is the booking currency. USD is carried only as a memo on the lines
-- that move dollars (inventory, revenue) and is never added to taka.
--
-- Every entry must balance (Σ debit = Σ credit, at least two lines). That is
-- checked by a DEFERRED constraint trigger, i.e. at COMMIT, after all of an
-- entry's lines are in — a posting that would leave an unbalanced entry rolls
-- back whole. Entries and lines are insert-only (finance_block_mutation).
--
-- POSTING IS DONE BY TRIGGERS on the source tables, so no code path — the
-- RPCs, the legacy plain insert into usd_purchases, the agency-sale server fn
-- — can record money without its journal entry:
--   usd_purchases  INSERT                → purchase entry
--                  status → REVERSED     → mirror entry
--   usd_outflows   INSERT (deferred: the RPC sets bdt_cost after allocating)
--                  status → REVERSED     → mirror entry
--   usd_sales      INSERT                → sale entry + receipt entry
--
-- Posting map (owner-approved model, 2026-10-20):
--   purchase                Dr 1200 USD inventory   Cr 1010 Bank & cash
--                           (principal and the bank fee as separate credits)
--   purchase, pre-v2        Dr 1200                 Cr 3000 Opening balance equity
--   Meta bill paid          Dr 5000 Service cost    Cr 1200   (FIFO cost)
--   opening adjustment      Dr 3000                 Cr 1200   (USD used before v2)
--   other outflow           Dr 5900 Other outflows  Cr 1200
--   agency sale             Dr 1300 Receivables     Cr 4000 Revenue
--   …its BDT received       Dr 1010                 Cr 1300   (v1: a sale is
--                           recorded paid; real receivables are Milestone 4 —
--                           a payment never creates revenue)
--
-- A source row deleted later (only staging tests do that; the app never
-- deletes) leaves its journal entry: the journal is the history.
--
-- Backfill: every existing purchase, outflow and sale is posted, in event
-- order, plus the reversal entry of anything already reversed.
--
-- Access as 000059: RLS on, zero policies, grants revoked from anon /
-- authenticated, functions service_role only.
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   drop trigger … on usd_purchases / usd_outflows / usd_sales (four);
--   drop function public.gl_trial_balance, public.journal_post,
--     public.journal_reverse, public.journal_post_purchase,
--     public.journal_post_outflow, public.journal_post_sale,
--     public.trg_journal_purchase, public.trg_journal_outflow_insert,
--     public.trg_journal_outflow_reversed, public.trg_journal_sale,
--     public.journal_check_balanced;
--   drop table public.journal_lines, public.journal_entries, public.gl_accounts;
--   drop sequence public.journal_entry_seq;
-- ============================================================================

-- ------------------------------------------------------- chart of accounts ---
create table public.gl_accounts (
  code        text primary key check (code ~ '^[0-9]{4}$'),
  name        text not null,
  type        text not null check (type in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  -- Balances are shown positive on this side.
  normal_side text not null check (normal_side in ('DEBIT', 'CREDIT')),
  -- The account moves dollars; its lines carry a USD memo.
  tracks_usd  boolean not null default false,
  description text,
  created_at  timestamptz not null default now()
);

insert into public.gl_accounts (code, name, type, normal_side, tracks_usd, description) values
  ('1010', 'Bank & cash', 'ASSET', 'DEBIT', false, 'Taka in the platform''s bank accounts and cash'),
  ('1200', 'USD inventory', 'ASSET', 'DEBIT', true, 'Dollars held in wallets, at FIFO cost'),
  ('1300', 'Agency receivables', 'ASSET', 'DEBIT', false, 'What agencies owe the platform'),
  ('1400', 'Meta prepaid', 'ASSET', 'DEBIT', true, 'Dollars loaded onto prepaid Meta accounts (Milestone 3)'),
  ('2100', 'Supplier payables', 'LIABILITY', 'CREDIT', false, 'USD received but not yet paid for'),
  ('2200', 'Meta payables', 'LIABILITY', 'CREDIT', true, 'Meta spend not yet settled (Milestone 3)'),
  ('2300', 'Agency advances', 'LIABILITY', 'CREDIT', false, 'Agency payments above what is owed (Milestone 4)'),
  ('3000', 'Opening balance equity', 'EQUITY', 'CREDIT', false, 'USD stock carried in from before Finance v2'),
  ('4000', 'Revenue — USD sales', 'REVENUE', 'CREDIT', true, 'Credit sold to agencies'),
  ('5000', 'Service cost — Meta', 'EXPENSE', 'DEBIT', true, 'FIFO cost of the dollars paid to Meta'),
  ('5900', 'Other USD outflows', 'EXPENSE', 'DEBIT', true, 'Dollars that left for anything else'),
  ('6900', 'FX difference', 'EXPENSE', 'DEBIT', false, 'Unused in v1 — no FX revaluation (Assumption 10)');

-- ----------------------------------------------------------------- journal ---
create sequence public.journal_entry_seq;

create table public.journal_entries (
  id           uuid primary key default gen_random_uuid(),
  entry_number text not null unique
                 default ('JE-' || lpad(nextval('public.journal_entry_seq')::text, 6, '0')),
  event_at     timestamptz not null,
  source_type  text not null
                 check (source_type in ('USD_PURCHASE', 'USD_OUTFLOW', 'USD_SALE', 'USD_SALE_RECEIPT', 'MANUAL')),
  source_id    uuid,
  is_reversal  boolean not null default false,
  reversal_of  uuid references public.journal_entries (id),
  description  text not null,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  check (is_reversal = (reversal_of is not null))
);
-- Exactly one posting, and at most one reversal, per source event.
create unique index uq_journal_entries_source
  on public.journal_entries (source_type, source_id, is_reversal)
  where source_id is not null;
create index idx_journal_entries_event on public.journal_entries (event_at desc);

create table public.journal_lines (
  id           uuid primary key default gen_random_uuid(),
  entry_id     uuid not null references public.journal_entries (id),
  line_no      integer not null,
  account_code text not null references public.gl_accounts (code),
  debit_bdt    numeric(18, 2) not null default 0 check (debit_bdt >= 0),
  credit_bdt   numeric(18, 2) not null default 0 check (credit_bdt >= 0),
  -- Dollars moved, positive, on the same side as the taka.
  usd_amount   numeric(24, 6) check (usd_amount is null or usd_amount >= 0),
  memo         text,
  check ((debit_bdt > 0) <> (credit_bdt > 0)),
  unique (entry_id, line_no)
);
create index idx_journal_lines_account on public.journal_lines (account_code);

-- Σ debit = Σ credit and ≥ 2 lines, per entry, checked at COMMIT.
create or replace function public.journal_check_balanced()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_entry uuid;
  v_dr numeric;
  v_cr numeric;
  v_n  integer;
begin
  -- From journal_entries the row's id is the entry; from lines, entry_id.
  -- (Branch first: NEW has no entry_id field on journal_entries.)
  if tg_table_name = 'journal_entries' then
    v_entry := new.id;
  else
    v_entry := new.entry_id;
  end if;
  select coalesce(sum(debit_bdt), 0), coalesce(sum(credit_bdt), 0), count(*)
    into v_dr, v_cr, v_n
  from public.journal_lines where entry_id = v_entry;
  if v_n < 2 or v_dr <> v_cr then
    raise exception 'UNBALANCED: journal entry % has % lines, debits % and credits %', v_entry, v_n, v_dr, v_cr;
  end if;
  return null;
end;
$$;
create constraint trigger trg_journal_lines_balanced
  after insert on public.journal_lines
  deferrable initially deferred
  for each row execute function public.journal_check_balanced();
create constraint trigger trg_journal_entries_balanced
  after insert on public.journal_entries
  deferrable initially deferred
  for each row execute function public.journal_check_balanced();

create trigger trg_journal_entries_immutable
  before update or delete on public.journal_entries
  for each row execute function public.finance_block_mutation();
create trigger trg_journal_lines_immutable
  before update or delete on public.journal_lines
  for each row execute function public.finance_block_mutation();

alter table public.gl_accounts     enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines   enable row level security;
revoke all on public.gl_accounts, public.journal_entries, public.journal_lines from anon, authenticated;
revoke all on sequence public.journal_entry_seq from anon, authenticated;

-- ------------------------------------------------------- posting helpers ---
-- p_lines: [{account, debit, credit, usd, memo}] — zero-amount lines are
-- dropped (a free bank route posts no bank-fee line).
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
  insert into public.journal_entries (event_at, source_type, source_id, description, created_by)
  values (p_event_at, p_source_type, p_source_id, p_description, p_actor)
  returning id into v_id;
  for v_l in select * from jsonb_array_elements(p_lines) loop
    if coalesce((v_l->>'debit')::numeric, 0) = 0 and coalesce((v_l->>'credit')::numeric, 0) = 0 then
      continue;
    end if;
    v_n := v_n + 1;
    insert into public.journal_lines (entry_id, line_no, account_code, debit_bdt, credit_bdt, usd_amount, memo)
    values (v_id, v_n, v_l->>'account', coalesce((v_l->>'debit')::numeric, 0),
            coalesce((v_l->>'credit')::numeric, 0), (v_l->>'usd')::numeric, v_l->>'memo');
  end loop;
  return v_id;
end;
$$;

-- The mirror of a source's posting: every line with debit and credit swapped.
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
  select * into v_orig from public.journal_entries
    where source_type = p_source_type and source_id = p_source_id and not is_reversal;
  if not found then
    raise exception 'NOT_FOUND: no journal entry for % %', p_source_type, p_source_id;
  end if;
  insert into public.journal_entries (event_at, source_type, source_id, is_reversal, reversal_of, description, created_by)
  values (p_event_at, p_source_type, p_source_id, true, v_orig.id,
          'Reversal of ' || v_orig.entry_number || coalesce(': ' || nullif(btrim(p_reason), ''), ''), p_actor)
  returning id into v_id;
  insert into public.journal_lines (entry_id, line_no, account_code, debit_bdt, credit_bdt, usd_amount, memo)
  select v_id, line_no, account_code, credit_bdt, debit_bdt, usd_amount, memo
  from public.journal_lines where entry_id = v_orig.id;
  return v_id;
end;
$$;

create or replace function public.journal_post_purchase(p public.usd_purchases)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
begin
  select name into v_source from public.usd_sources where id = p.source_id;
  return public.journal_post(
    'USD_PURCHASE', p.id, p.purchased_at,
    case when p.is_opening then 'Opening batch #' else 'USD purchase, batch #' end
      || p.posting_seq || ' from ' || coalesce(v_source, 'a source'),
    p.recorded_by,
    case when p.is_opening then jsonb_build_array(
      jsonb_build_object('account', '1200', 'debit', p.bdt_amount, 'usd', p.net_usd),
      jsonb_build_object('account', '3000', 'credit', p.bdt_amount, 'memo', 'Recorded before Finance v2'))
    else jsonb_build_array(
      jsonb_build_object('account', '1200', 'debit', p.bdt_amount, 'usd', p.net_usd),
      jsonb_build_object('account', '1010', 'credit', p.bdt_principal, 'memo', 'Paid to supplier'),
      jsonb_build_object('account', '1010', 'credit', p.capitalized_fees_bdt, 'memo', 'Bank fee'))
    end);
end;
$$;

create or replace function public.journal_post_outflow(o public.usd_outflows)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_debit text := case o.kind
    when 'META_BILL_PAYMENT' then '5000'
    when 'OPENING_ADJUSTMENT' then '3000'
    else '5900' end;
begin
  return public.journal_post(
    'USD_OUTFLOW', o.id, o.event_at,
    o.reference_id || ' — ' || case o.kind
      when 'META_BILL_PAYMENT' then 'Meta bill paid'
      when 'OPENING_ADJUSTMENT' then 'USD used before Finance v2'
      else coalesce(o.notes, 'USD paid out') end,
    o.recorded_by,
    jsonb_build_array(
      jsonb_build_object('account', v_debit, 'debit', o.bdt_cost, 'usd', o.usd_amount),
      jsonb_build_object('account', '1200', 'credit', o.bdt_cost, 'usd', o.usd_amount, 'memo', 'FIFO cost')));
end;
$$;

create or replace function public.journal_post_sale(s public.usd_sales)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.journal_post(
    'USD_SALE', s.id, s.sold_at,
    s.reference_id || ' — USD sold to ' || s.agency_name,
    s.recorded_by,
    jsonb_build_array(
      jsonb_build_object('account', '1300', 'debit', s.bdt_amount),
      jsonb_build_object('account', '4000', 'credit', s.bdt_amount, 'usd', s.usd_amount)));
  perform public.journal_post(
    'USD_SALE_RECEIPT', s.id, s.sold_at,
    s.reference_id || ' — BDT received from ' || s.agency_name,
    s.recorded_by,
    jsonb_build_array(
      jsonb_build_object('account', '1010', 'debit', s.bdt_amount),
      jsonb_build_object('account', '1300', 'credit', s.bdt_amount, 'memo', 'Recorded as paid at sale (v1)')));
end;
$$;

-- ---------------------------------------------------------------- triggers ---
create or replace function public.trg_journal_purchase()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.journal_post_purchase(new);
  elsif new.status = 'REVERSED' and old.status = 'POSTED' then
    perform public.journal_reverse('USD_PURCHASE', new.id, new.reversed_at, new.reversal_reason, new.reversed_by);
  end if;
  return null;
end;
$$;
create trigger trg_usd_purchases_journal
  after insert or update of status on public.usd_purchases
  for each row execute function public.trg_journal_purchase();

-- Deferred: post_usd_outflow() inserts with bdt_cost 0 and sets it after
-- allocating, in the same transaction; the entry must use the final figure.
create or replace function public.trg_journal_outflow_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.usd_outflows;
begin
  -- Already posted if it was reversed in this same transaction (the reversal
  -- trigger posts it first).
  if exists (select 1 from public.journal_entries
             where source_type = 'USD_OUTFLOW' and source_id = new.id and not is_reversal) then
    return null;
  end if;
  select * into v_row from public.usd_outflows where id = new.id;
  perform public.journal_post_outflow(v_row);
  return null;
end;
$$;
create constraint trigger trg_usd_outflows_journal
  after insert on public.usd_outflows
  deferrable initially deferred
  for each row execute function public.trg_journal_outflow_insert();

create or replace function public.trg_journal_outflow_reversed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'REVERSED' and old.status = 'POSTED' then
    -- Same transaction as the insert would be unusual, but if it is, the
    -- posting has not run yet (it is deferred): post it first.
    if not exists (select 1 from public.journal_entries
                   where source_type = 'USD_OUTFLOW' and source_id = new.id and not is_reversal) then
      perform public.journal_post_outflow(new);
    end if;
    perform public.journal_reverse('USD_OUTFLOW', new.id, new.reversed_at, new.reversal_reason, new.reversed_by);
  end if;
  return null;
end;
$$;
create trigger trg_usd_outflows_journal_reversed
  after update of status on public.usd_outflows
  for each row execute function public.trg_journal_outflow_reversed();

create or replace function public.trg_journal_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.journal_post_sale(new);
  return null;
end;
$$;
create trigger trg_usd_sales_journal
  after insert on public.usd_sales
  for each row execute function public.trg_journal_sale();

-- --------------------------------------------------------------- backfill ---
do $$
declare
  p public.usd_purchases;
  o public.usd_outflows;
  s public.usd_sales;
begin
  for p in select * from public.usd_purchases order by posting_seq loop
    perform public.journal_post_purchase(p);
  end loop;
  for o in select * from public.usd_outflows order by event_at, created_at loop
    perform public.journal_post_outflow(o);
  end loop;
  for s in select * from public.usd_sales order by sold_at, created_at loop
    perform public.journal_post_sale(s);
  end loop;
  -- Reversals after every posting, in the order they happened.
  for p in select * from public.usd_purchases where status = 'REVERSED' order by reversed_at loop
    perform public.journal_reverse('USD_PURCHASE', p.id, p.reversed_at, p.reversal_reason, p.reversed_by);
  end loop;
  for o in select * from public.usd_outflows where status = 'REVERSED' order by reversed_at loop
    perform public.journal_reverse('USD_OUTFLOW', o.id, o.reversed_at, o.reversal_reason, o.reversed_by);
  end loop;
end;
$$;

-- --------------------------------------------------------- trial balance ---
-- Per account, everything with event_at ≤ p_as_of. balance is positive on the
-- account's normal side; usd is the net USD memo (debit +, credit −) flipped
-- the same way. Accounts with no lines are listed with zeros.
create or replace function public.gl_trial_balance(p_as_of timestamptz)
returns table (
  code        text,
  name        text,
  type        text,
  normal_side text,
  debit_bdt   numeric,
  credit_bdt  numeric,
  balance_bdt numeric,
  usd         numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.code, a.name, a.type, a.normal_side,
    coalesce(sum(l.debit_bdt), 0),
    coalesce(sum(l.credit_bdt), 0),
    case when a.normal_side = 'DEBIT'
      then coalesce(sum(l.debit_bdt), 0) - coalesce(sum(l.credit_bdt), 0)
      else coalesce(sum(l.credit_bdt), 0) - coalesce(sum(l.debit_bdt), 0) end,
    case when a.tracks_usd then
      (case when a.normal_side = 'DEBIT' then 1 else -1 end) *
      coalesce(sum(case when l.debit_bdt > 0 then l.usd_amount else -l.usd_amount end), 0)
    end
  from public.gl_accounts a
  left join (
    public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id and e.event_at <= p_as_of
  ) on l.account_code = a.code
  group by a.code, a.name, a.type, a.normal_side, a.tracks_usd
  order by a.code
$$;

revoke all on function public.journal_check_balanced() from public, anon, authenticated;
revoke all on function public.trg_journal_purchase() from public, anon, authenticated;
revoke all on function public.trg_journal_outflow_insert() from public, anon, authenticated;
revoke all on function public.trg_journal_outflow_reversed() from public, anon, authenticated;
revoke all on function public.trg_journal_sale() from public, anon, authenticated;
revoke all on function public.journal_post(text, uuid, timestamptz, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.journal_reverse(text, uuid, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function public.journal_post_purchase(public.usd_purchases) from public, anon, authenticated;
revoke all on function public.journal_post_outflow(public.usd_outflows) from public, anon, authenticated;
revoke all on function public.journal_post_sale(public.usd_sales) from public, anon, authenticated;
revoke all on function public.gl_trial_balance(timestamptz) from public, anon, authenticated;
grant execute on function public.gl_trial_balance(timestamptz) to service_role;

comment on table public.journal_entries is
  'Platform double-entry journal. One entry per posted event (+ one per reversal), posted by triggers. Insert-only; balanced at commit.';
comment on table public.journal_lines is
  'Journal lines: debit OR credit in BDT, optional USD memo. Insert-only.';
