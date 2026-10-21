-- ============================================================================
-- Finance v2, Milestone 5 — reconciliation, opening bank balance, prepaid
-- credit return / write-off, spend attributed to agencies, profit report.
-- docs/ACCOUNTING_POLICY.md §11.
--
--   finance_openings        the platform's bank balance at go-live (once):
--                           Dr 1010 / Cr 3000, so "Bank & cash" becomes the
--                           real balance, not net movement.
--   reconciliation_records  the owner's actual wallet (USD) or bank (BDT)
--                           balance against the books, the difference, and how
--                           it was resolved. Records only — a difference is
--                           fixed by a real transaction, never by this table.
--   meta_prepaid_adjustments unspent prepaid credit leaving an account:
--                           RETURN  → back into inventory as a new batch at the
--                                     lot's original cost (Dr 1200 / Cr 1400);
--                           WRITE_OFF → an expense with a reason
--                                     (Dr 5800 / Cr 1400).
--   usd_purchases.kind      PURCHASE | PREPAID_RETURN (a return batch has no
--                           supplier); reverse_usd_purchase refuses a return
--                           batch — it is reversed from its adjustment.
--   meta_spend_events.agency_org_id  who held the pool account when the spend
--                           was read (grants keep no history), so profit can
--                           be estimated per agency.
--   finance_profit_report(from, to)  revenue, costs, gross profit, per-agency
--                           estimate and costs still to come, by event date.
--
-- MANUAL ROLLBACK: drop the new functions, triggers and tables; restore
-- journal_post_purchase / reverse_usd_purchase / meta_spend_post /
-- meta_prepaid_lot_balances / set_meta_billing_mode from 000061/000059/000063;
-- drop the added columns and constraints; restore the source_type check.
-- ============================================================================

insert into public.gl_accounts (code, name, type, normal_side, tracks_usd, description) values
  ('5800', 'Prepaid credit written off', 'EXPENSE', 'DEBIT', true, 'Unspent prepaid Meta credit written off, with a reason');

alter table public.journal_entries drop constraint journal_entries_source_type_check;
alter table public.journal_entries add constraint journal_entries_source_type_check
  check (source_type in ('USD_PURCHASE', 'USD_OUTFLOW', 'USD_SALE', 'USD_SALE_RECEIPT', 'META_SPEND',
                         'AGENCY_CHARGE', 'AGENCY_ADVANCE_APPLIED', 'AGENCY_PAYMENT',
                         'OPENING_BANK', 'PREPAID_ADJUSTMENT', 'MANUAL'));

-- ------------------------------------------------------- opening balances ---
create table public.finance_openings (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('BANK')),
  -- Negative = overdrawn.
  bdt_amount      numeric(18, 2) not null check (bdt_amount <> 0),
  as_of           timestamptz not null,
  notes           text not null check (length(btrim(notes)) > 0),
  status          text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversed_by     uuid references auth.users (id),
  reversed_at     timestamptz,
  reversal_reason text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now()
);
create unique index uq_finance_openings_live on public.finance_openings (kind) where status = 'POSTED';
create trigger trg_finance_openings_no_delete
  before delete on public.finance_openings
  for each row execute function public.finance_block_mutation();

create or replace function public.trg_finance_opening_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.journal_post('OPENING_BANK', new.id, new.as_of, 'Bank & cash at go-live: ' || new.notes, new.created_by,
      case when new.bdt_amount > 0 then jsonb_build_array(
        jsonb_build_object('account', '1010', 'debit', new.bdt_amount),
        jsonb_build_object('account', '3000', 'credit', new.bdt_amount))
      else jsonb_build_array(
        jsonb_build_object('account', '3000', 'debit', -new.bdt_amount),
        jsonb_build_object('account', '1010', 'credit', -new.bdt_amount))
      end);
  elsif new.status = 'REVERSED' and old.status = 'POSTED' then
    perform public.journal_reverse('OPENING_BANK', new.id, new.reversed_at, new.reversal_reason, new.reversed_by);
  end if;
  return null;
end;
$$;
create trigger trg_finance_openings_journal
  after insert or update of status on public.finance_openings
  for each row execute function public.trg_finance_opening_journal();

-- --------------------------------------------------------- reconciliation ---
create table public.reconciliation_records (
  id              uuid primary key default gen_random_uuid(),
  scope           text not null check (scope in ('USD_WALLETS', 'BANK')),
  currency        text not null check (currency in ('USD', 'BDT')),
  as_of           timestamptz not null,
  expected        numeric(18, 2) not null,
  actual          numeric(18, 2) not null,
  difference      numeric(18, 2) generated always as (actual - expected) stored,
  -- USD_WALLETS: [{wallet, usd}] — what each wallet showed.
  details         jsonb not null default '[]'::jsonb,
  note            text,
  status          text not null check (status in ('MATCHED', 'DIFFERENCE', 'RESOLVED')),
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users (id),
  resolution_note text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now()
);
create index idx_reconciliation_records_scope on public.reconciliation_records (scope, created_at desc);
create trigger trg_reconciliation_records_no_delete
  before delete on public.reconciliation_records
  for each row execute function public.finance_block_mutation();

-- -------------------------------------------------- prepaid adjustments ---
alter table public.usd_purchases
  add column kind text not null default 'PURCHASE' check (kind in ('PURCHASE', 'PREPAID_RETURN')),
  alter column source_id drop not null,
  add constraint usd_purchases_source_for_purchase check (kind = 'PREPAID_RETURN' or source_id is not null);

create sequence public.meta_prepaid_adjustment_seq;

create table public.meta_prepaid_adjustments (
  id              uuid primary key default gen_random_uuid(),
  reference_id    text not null
                    default ('PPA-' || lpad(nextval('public.meta_prepaid_adjustment_seq')::text, 6, '0')),
  -- One action (return / write-off of N USD) can take from several lots:
  -- one row per lot, sharing a group id and reference.
  group_id        uuid not null,
  lot_id          uuid not null references public.meta_prepaid_lots (id),
  ad_account_id   uuid references public.ad_accounts (id) on delete set null,
  kind            text not null check (kind in ('RETURN', 'WRITE_OFF')),
  usd             numeric(24, 6) not null check (usd > 0),
  bdt             numeric(18, 2) not null check (bdt >= 0),
  return_batch_id uuid references public.usd_purchases (id),
  event_at        timestamptz not null,
  reason          text not null check (length(btrim(reason)) > 0),
  status          text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversed_by     uuid references auth.users (id),
  reversed_at     timestamptz,
  reversal_reason text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  check ((kind = 'RETURN') = (return_batch_id is not null))
);
create index idx_meta_prepaid_adjustments_lot on public.meta_prepaid_adjustments (lot_id);
create index idx_meta_prepaid_adjustments_group on public.meta_prepaid_adjustments (group_id);
create trigger trg_meta_prepaid_adjustments_no_delete
  before delete on public.meta_prepaid_adjustments
  for each row execute function public.finance_block_mutation();

-- A lot's remainder now also nets posted adjustments. Same columns as 000063.
create or replace view public.meta_prepaid_lot_balances
  with (security_invoker = true) as
select
  l.id as lot_id,
  l.ad_account_id,
  l.seq,
  o.status,
  l.usd,
  l.bdt,
  l.usd - coalesce(a.used_usd, 0) - coalesce(x.adj_usd, 0) as left_usd,
  l.bdt - coalesce(a.used_bdt, 0) - coalesce(x.adj_bdt, 0) as left_bdt
from public.meta_prepaid_lots l
join public.usd_outflows o on o.id = l.funding_outflow_id
left join (
  select lot_id, sum(usd) as used_usd, sum(bdt) as used_bdt
  from public.meta_prepaid_allocations group by lot_id
) a on a.lot_id = l.id
left join (
  select lot_id, sum(usd) as adj_usd, sum(bdt) as adj_bdt
  from public.meta_prepaid_adjustments where status = 'POSTED' group by lot_id
) x on x.lot_id = l.id;

-- A write-off posts per lot row; a return posts once, through its batch.
create or replace function public.trg_meta_prepaid_adjustment_journal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account text;
begin
  if new.kind <> 'WRITE_OFF' then return null; end if;
  if tg_op = 'INSERT' then
    select account_code || ' · ' || name into v_account from public.ad_accounts where id = new.ad_account_id;
    perform public.journal_post('PREPAID_ADJUSTMENT', new.id, new.event_at,
      new.reference_id || ' — prepaid credit written off' || coalesce(', ' || v_account, '') || ': ' || new.reason,
      new.created_by,
      jsonb_build_array(
        jsonb_build_object('account', '5800', 'debit', new.bdt, 'usd', new.usd),
        jsonb_build_object('account', '1400', 'credit', new.bdt, 'usd', new.usd)));
  elsif new.status = 'REVERSED' and old.status = 'POSTED' then
    perform public.journal_reverse('PREPAID_ADJUSTMENT', new.id, new.reversed_at, new.reversal_reason, new.reversed_by);
  end if;
  return null;
end;
$$;
create trigger trg_meta_prepaid_adjustments_journal
  after insert or update of status on public.meta_prepaid_adjustments
  for each row execute function public.trg_meta_prepaid_adjustment_journal();

-- 000061's purchase posting + a return batch: Dr 1200 / Cr 1400.
create or replace function public.journal_post_purchase(p public.usd_purchases)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
begin
  if p.kind = 'PREPAID_RETURN' then
    return public.journal_post('USD_PURCHASE', p.id, p.purchased_at,
      'Prepaid credit returned to stock, batch #' || p.posting_seq || coalesce(': ' || p.notes, ''),
      p.recorded_by,
      jsonb_build_array(
        jsonb_build_object('account', '1200', 'debit', p.bdt_amount, 'usd', p.net_usd),
        jsonb_build_object('account', '1400', 'credit', p.bdt_amount, 'usd', p.net_usd, 'memo', 'At the lot''s original cost')));
  end if;
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

-- 000059's reverse_usd_purchase + a return batch is reversed only through its
-- adjustment (so the lot gets its credit back in the same step).
create or replace function public.reverse_usd_purchase(p_actor uuid, p_purchase_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.usd_purchases;
  v_used numeric;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Give a reason for the reversal';
  end if;
  select * into v_row from public.usd_purchases where id = p_purchase_id for update;
  if not found then raise exception 'NOT_FOUND: Purchase not found'; end if;
  if v_row.status <> 'POSTED' then raise exception 'ALREADY_REVERSED: This purchase is already reversed'; end if;
  if v_row.kind = 'PREPAID_RETURN' then
    raise exception 'RETURN_BATCH: This batch is prepaid credit returned from a Meta account — reverse the return on the Meta Accounts tab';
  end if;
  select used_usd into v_used from public.usd_batch_balances where batch_id = p_purchase_id;
  if v_used <> 0 then
    raise exception 'BATCH_CONSUMED: % USD of this purchase is already in use; reverse those outflows first', round(v_used, 2);
  end if;

  update public.usd_purchases
  set status = 'REVERSED', reversed_by = p_actor, reversed_at = now(), reversal_reason = btrim(p_reason)
  where id = p_purchase_id
  returning * into v_row;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'USD_BATCH_REVERSED', 'USD_PURCHASE', p_purchase_id, jsonb_build_object('reason', btrim(p_reason)));
  return to_jsonb(v_row);
end;
$$;

-- Take N USD of an account's unspent prepaid credit, oldest lot first, and
-- return it to stock or write it off.
create or replace function public.adjust_prepaid_credit(
  p_actor uuid, p_account uuid, p_kind text, p_usd numeric, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group uuid := gen_random_uuid();
  v_ref   text := 'PPA-' || lpad(nextval('public.meta_prepaid_adjustment_seq')::text, 6, '0');
  v_left  numeric;
  v_need  numeric;
  v_take  numeric;
  v_cost  numeric;
  v_total numeric := 0;
  v_batch public.usd_purchases;
  v_name  text;
  v_takes jsonb := '[]'::jsonb;
  t       jsonb;
  l       record;
begin
  perform public.finance_v2_lock();
  if p_kind not in ('RETURN', 'WRITE_OFF') then raise exception 'INVALID_KIND: Return or write off'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'REASON_REQUIRED: Give a reason'; end if;
  if p_usd is null or p_usd <= 0 or p_usd <> round(p_usd, 2) then
    raise exception 'INVALID_AMOUNT: Enter a USD amount greater than zero, to the cent';
  end if;
  select account_code || ' · ' || name into v_name from public.ad_accounts where id = p_account and is_platform;
  if not found then raise exception 'NOT_FOUND: Choose a platform ad account'; end if;
  select coalesce(sum(left_usd), 0) into v_left from public.meta_prepaid_lot_balances
    where ad_account_id = p_account and status = 'POSTED';
  if v_left < p_usd then
    raise exception 'INSUFFICIENT_INVENTORY: Only % USD of prepaid credit is left on this account', round(v_left, 2);
  end if;

  -- Work out what each lot gives (same rounding as every FIFO walk).
  v_need := p_usd;
  for l in
    select lot_id, left_usd, left_bdt from public.meta_prepaid_lot_balances
    where ad_account_id = p_account and status = 'POSTED' and left_usd > 0
    order by seq, lot_id
  loop
    exit when v_need <= 0;
    v_take := least(l.left_usd, v_need);
    v_cost := case when v_take = l.left_usd then l.left_bdt else round(v_take * l.left_bdt / l.left_usd, 2) end;
    v_takes := v_takes || jsonb_build_object('lot', l.lot_id, 'usd', v_take, 'bdt', v_cost);
    v_need := v_need - v_take;
    v_total := v_total + v_cost;
  end loop;

  if p_kind = 'RETURN' then
    insert into public.usd_purchases (
      kind, source_id, method, usd_amount, bdt_amount, purchased_at, recorded_by, notes,
      gross_usd, net_usd, bdt_principal, supplier_rate, effective_rate)
    values ('PREPAID_RETURN', null, 'Prepaid return', p_usd, v_total, now(), p_actor,
            v_ref || ' from ' || v_name || ': ' || btrim(p_reason),
            p_usd, p_usd, v_total, round(v_total / p_usd, 6), round(v_total / p_usd, 6))
    returning * into v_batch;
  end if;

  for t in select * from jsonb_array_elements(v_takes) loop
    insert into public.meta_prepaid_adjustments (
      reference_id, group_id, lot_id, ad_account_id, kind, usd, bdt, return_batch_id, event_at, reason, created_by)
    values (v_ref, v_group, (t->>'lot')::uuid, p_account, p_kind, (t->>'usd')::numeric, (t->>'bdt')::numeric,
            v_batch.id, now(), btrim(p_reason), p_actor);
  end loop;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'PREPAID_CREDIT_' || p_kind, 'AD_ACCOUNT', p_account,
          jsonb_build_object('reference', v_ref, 'usd', p_usd, 'bdt', v_total, 'reason', btrim(p_reason)));
  return jsonb_build_object('group_id', v_group, 'reference_id', v_ref, 'usd', p_usd, 'bdt', v_total,
                            'return_batch_id', v_batch.id);
end;
$$;

-- Undo a return (only while its batch is unused) or a write-off.
create or replace function public.reverse_prepaid_adjustment(p_actor uuid, p_group uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first public.meta_prepaid_adjustments;
  v_used  numeric;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Give a reason for the reversal';
  end if;
  select * into v_first from public.meta_prepaid_adjustments where group_id = p_group limit 1;
  if not found then raise exception 'NOT_FOUND: Adjustment not found'; end if;
  if v_first.status <> 'POSTED' then raise exception 'ALREADY_REVERSED: Already reversed'; end if;
  if v_first.kind = 'RETURN' then
    select used_usd into v_used from public.usd_batch_balances where batch_id = v_first.return_batch_id;
    if v_used <> 0 then
      raise exception 'BATCH_CONSUMED: % USD of the returned credit has already been used from stock', round(v_used, 2);
    end if;
    update public.usd_purchases
    set status = 'REVERSED', reversed_by = p_actor, reversed_at = now(), reversal_reason = btrim(p_reason)
    where id = v_first.return_batch_id;
  end if;
  update public.meta_prepaid_adjustments
  set status = 'REVERSED', reversed_by = p_actor, reversed_at = now(), reversal_reason = btrim(p_reason)
  where group_id = p_group;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'PREPAID_ADJUSTMENT_REVERSED', 'AD_ACCOUNT', v_first.ad_account_id,
          jsonb_build_object('reference', v_first.reference_id, 'reason', btrim(p_reason)));
  return jsonb_build_object('reversed', v_first.reference_id);
end;
$$;

-- --------------------------------------------------- opening bank / recon ---
create or replace function public.record_opening_bank(p_actor uuid, p_bdt numeric, p_as_of timestamptz, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.finance_openings;
begin
  perform public.finance_v2_lock();
  if p_bdt is null or p_bdt = 0 or p_bdt <> round(p_bdt, 2) then
    raise exception 'INVALID_AMOUNT: Enter the bank balance in BDT (negative if overdrawn)';
  end if;
  if nullif(btrim(coalesce(p_notes, '')), '') is null then
    raise exception 'NOTE_REQUIRED: Say which accounts and statements this comes from';
  end if;
  begin
    insert into public.finance_openings (kind, bdt_amount, as_of, notes, created_by)
    values ('BANK', p_bdt, p_as_of, btrim(p_notes), p_actor)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'DUPLICATE: The opening bank balance is already set — reverse it first to change it';
  end;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'OPENING_BANK_SET', 'FINANCE_OPENING', v_row.id, jsonb_build_object('bdt', p_bdt));
  return to_jsonb(v_row);
end;
$$;

create or replace function public.reverse_opening_bank(p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.finance_openings;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'REASON_REQUIRED: Give a reason'; end if;
  update public.finance_openings
  set status = 'REVERSED', reversed_by = p_actor, reversed_at = now(), reversal_reason = btrim(p_reason)
  where kind = 'BANK' and status = 'POSTED'
  returning * into v_row;
  if not found then raise exception 'NOT_FOUND: No opening bank balance to reverse'; end if;
  return to_jsonb(v_row);
end;
$$;

-- The books' figure to compare with: USD wallets = everything in stock (FIFO,
-- all postings); bank = account 1010 as of the moment given.
create or replace function public.record_reconciliation(
  p_actor uuid, p_scope text, p_as_of timestamptz, p_actual numeric, p_details jsonb, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected numeric;
  v_row      public.reconciliation_records;
  v_currency text;
begin
  perform public.finance_v2_lock();
  if p_actual is null then raise exception 'INVALID_AMOUNT: Enter the actual balance'; end if;
  if p_scope = 'USD_WALLETS' then
    v_currency := 'USD';
    select round(coalesce(sum(left_usd), 0), 2) into v_expected from public.usd_batch_balances where status = 'POSTED';
  elsif p_scope = 'BANK' then
    v_currency := 'BDT';
    select coalesce(sum(l.debit_bdt - l.credit_bdt), 0) into v_expected
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
    where l.account_code = '1010' and e.event_at <= p_as_of;
  else
    raise exception 'INVALID_KIND: Unknown reconciliation';
  end if;
  insert into public.reconciliation_records (scope, currency, as_of, expected, actual, details, note, status, created_by)
  values (p_scope, v_currency, p_as_of, v_expected, round(p_actual, 2), coalesce(p_details, '[]'::jsonb),
          nullif(btrim(coalesce(p_note, '')), ''),
          case when abs(round(p_actual, 2) - v_expected) <= 1 then 'MATCHED' else 'DIFFERENCE' end, p_actor)
  returning * into v_row;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'RECONCILIATION_RECORDED', 'RECONCILIATION', v_row.id,
          jsonb_build_object('scope', p_scope, 'expected', v_expected, 'actual', p_actual));
  return to_jsonb(v_row);
end;
$$;

create or replace function public.resolve_reconciliation(p_actor uuid, p_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reconciliation_records;
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'REASON_REQUIRED: Say what explains the difference';
  end if;
  update public.reconciliation_records
  set status = 'RESOLVED', resolved_at = now(), resolved_by = p_actor, resolution_note = btrim(p_note)
  where id = p_id and status = 'DIFFERENCE'
  returning * into v_row;
  if not found then raise exception 'NOT_FOUND: No open difference with that id'; end if;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'RECONCILIATION_RESOLVED', 'RECONCILIATION', p_id, jsonb_build_object('note', btrim(p_note)));
  return to_jsonb(v_row);
end;
$$;

-- ------------------------------------------------- spend → agency snapshot ---
alter table public.meta_spend_events add column agency_org_id uuid references public.organizations (id) on delete set null;
update public.meta_spend_events e
set agency_org_id = g.organization_id
from public.platform_account_grants g
where g.ad_account_id = e.ad_account_id and e.agency_org_id is null;

-- 000063's meta_spend_post + the holder of the account at the time.
create or replace function public.meta_spend_post(
  p_actor        uuid,
  p_account      uuid,
  p_usd          numeric,
  p_event_at     timestamptz,
  p_source       text,
  p_reading_from numeric,
  p_reading_to   numeric,
  p_notes        text,
  p_key          text
)
returns public.meta_spend_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode   text;
  v_agency uuid;
  v_ev     public.meta_spend_events;
  v_need   numeric;
  v_take   numeric;
  v_cost   numeric;
  v_total  numeric := 0;
  v_cover  numeric := 0;
  l        record;
begin
  select meta_billing_mode into v_mode from public.ad_accounts where id = p_account;
  select organization_id into v_agency from public.platform_account_grants where ad_account_id = p_account;

  -- Prepaid starts fully unfunded and is re-split once the lots are consumed.
  insert into public.meta_spend_events (
    ad_account_id, agency_org_id, billing_mode, usd_amount, covered_usd, unfunded_usd, event_at, source,
    reading_from, reading_to, notes, idempotency_key, recorded_by)
  values (p_account, v_agency, v_mode, p_usd,
          0,
          case when v_mode = 'META_PREPAID' then p_usd else 0 end,
          p_event_at, p_source, p_reading_from, p_reading_to,
          nullif(btrim(coalesce(p_notes, '')), ''), p_key, p_actor)
  returning * into v_ev;

  if v_mode = 'META_PREPAID' then
    v_need := p_usd;
    for l in
      select lot_id, left_usd, left_bdt from public.meta_prepaid_lot_balances
      where ad_account_id = p_account and status = 'POSTED' and left_usd > 0
      order by seq, lot_id
    loop
      exit when v_need <= 0;
      v_take := least(l.left_usd, v_need);
      v_cost := case when v_take = l.left_usd then l.left_bdt
                     else round(v_take * l.left_bdt / l.left_usd, 2) end;
      insert into public.meta_prepaid_allocations (lot_id, spend_event_id, usd, unit_cost, bdt)
      values (l.lot_id, v_ev.id, v_take, round(l.left_bdt / l.left_usd, 6), v_cost);
      v_need := v_need - v_take;
      v_cover := v_cover + v_take;
      v_total := v_total + v_cost;
    end loop;

    update public.meta_spend_events
    set covered_usd = v_cover, unfunded_usd = p_usd - v_cover, bdt_cost = v_total
    where id = v_ev.id
    returning * into v_ev;

    if v_ev.unfunded_usd > 0 then
      insert into public.meta_spend_exceptions (ad_account_id, kind, usd, details, event_at)
      values (p_account, 'UNFUNDED_SPEND', v_ev.unfunded_usd,
              jsonb_build_object('spend_event', v_ev.reference_id, 'spend_usd', p_usd, 'covered_usd', v_cover),
              p_event_at);
    end if;
  end if;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'META_SPEND_POSTED', 'META_SPEND', v_ev.id, jsonb_build_object(
    'ad_account_id', p_account, 'usd', p_usd, 'mode', v_mode, 'source', p_source,
    'bdt_cost', v_ev.bdt_cost, 'unfunded_usd', v_ev.unfunded_usd, 'agency_org_id', v_agency));
  return v_ev;
end;
$$;

-- ---------------------------------------------------------- profit report ---
-- Everything by EVENT date in [p_from, p_to). Revenue and costs from the
-- journal; per agency from its charges and the spend read on accounts it held.
-- "Costs still to come" are as of now: dollars already billed to agencies
-- that Meta has not spent yet, and Meta spend whose bill is not paid yet —
-- revenue (or spend) is booked, the cost isn't.
create or replace function public.finance_profit_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with lines as (
    select l.account_code, l.debit_bdt, l.credit_bdt, l.usd_amount, l.party_org_id, e.source_type, e.source_id, e.is_reversal
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    where e.event_at >= p_from and e.event_at < p_to
  ),
  totals as (
    select
      coalesce(sum(credit_bdt - debit_bdt) filter (where account_code = '4000'), 0) as revenue_bdt,
      coalesce(sum(debit_bdt - credit_bdt) filter (where account_code = '5000'), 0) as meta_cost_bdt,
      coalesce(sum(case when debit_bdt > 0 then usd_amount else -usd_amount end) filter (where account_code = '5000'), 0) as meta_cost_usd,
      coalesce(sum(debit_bdt - credit_bdt) filter (where account_code = '5800'), 0) as write_off_bdt,
      coalesce(sum(debit_bdt - credit_bdt) filter (where account_code = '5900'), 0) as other_bdt
    from lines
  ),
  agency_rev as (
    select l.party_org_id as org, sum(l.debit_bdt - l.credit_bdt) as revenue_bdt
    from lines l join public.agency_charges c on c.id = l.source_id
    where l.source_type = 'AGENCY_CHARGE' and l.account_code = '1300' and c.kind = 'LIMIT_APPROVAL'
    group by l.party_org_id
  ),
  agency_billed as (
    select organization_id as org, sum(usd_amount) as billed_usd
    from public.agency_charges
    where kind = 'LIMIT_APPROVAL' and status = 'POSTED' and event_at >= p_from and event_at < p_to
    group by organization_id
  ),
  agency_spend as (
    select agency_org_id as org, sum(usd_amount) as spend_usd
    from public.meta_spend_events
    where status = 'POSTED' and event_at >= p_from and event_at < p_to
    group by agency_org_id
  ),
  agencies as (
    select org from agency_rev union select org from agency_billed union select org from agency_spend
  ),
  stock as (
    select sum(left_bdt) / nullif(sum(left_usd), 0) as avg_cost from public.usd_batch_balances where status = 'POSTED' and left_usd > 0
  ),
  to_come as (
    select
      coalesce((select sum(owed_usd) from public.meta_account_positions where owed_usd > 0), 0) as unpaid_meta_usd,
      greatest(
        coalesce((select sum(usd_amount) from public.agency_charges where kind = 'LIMIT_APPROVAL' and status = 'POSTED'), 0)
        - coalesce((select sum(usd_amount) from public.meta_spend_events
                    where status = 'POSTED' and event_at >= (select min(event_at) from public.agency_charges where kind = 'LIMIT_APPROVAL')), 0),
        0) as billed_unspent_usd
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'revenue_bdt', t.revenue_bdt,
    'meta_cost_bdt', t.meta_cost_bdt,
    'meta_cost_usd', t.meta_cost_usd,
    'write_off_bdt', t.write_off_bdt,
    'other_bdt', t.other_bdt,
    'gross_profit_bdt', t.revenue_bdt - t.meta_cost_bdt - t.write_off_bdt,
    'net_after_other_bdt', t.revenue_bdt - t.meta_cost_bdt - t.write_off_bdt - t.other_bdt,
    'avg_stock_cost', s.avg_cost,
    'unpaid_meta_usd', c.unpaid_meta_usd,
    'billed_unspent_usd', c.billed_unspent_usd,
    'agencies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organization_id', a.org,
        'name', case when a.org is null then 'Not held by an agency' else coalesce(o.name, 'Removed agency') end,
        'revenue_bdt', coalesce(r.revenue_bdt, 0),
        'billed_usd', coalesce(b.billed_usd, 0),
        'spend_usd', coalesce(sp.spend_usd, 0)) order by coalesce(r.revenue_bdt, 0) desc)
      from agencies a
      left join public.organizations o on o.id = a.org
      left join agency_rev r on r.org is not distinct from a.org
      left join agency_billed b on b.org is not distinct from a.org
      left join agency_spend sp on sp.org is not distinct from a.org
    ), '[]'::jsonb)
  )
  from totals t, stock s, to_come c
$$;

-- ----------------------------------------------------------------- access ---
alter table public.finance_openings         enable row level security;
alter table public.reconciliation_records   enable row level security;
alter table public.meta_prepaid_adjustments enable row level security;
revoke all on public.finance_openings, public.reconciliation_records, public.meta_prepaid_adjustments from anon, authenticated;
revoke all on sequence public.meta_prepaid_adjustment_seq from anon, authenticated;
revoke all on public.meta_prepaid_lot_balances from anon, authenticated;

revoke all on function public.trg_finance_opening_journal() from public, anon, authenticated;
revoke all on function public.trg_meta_prepaid_adjustment_journal() from public, anon, authenticated;
revoke all on function public.journal_post_purchase(public.usd_purchases) from public, anon, authenticated;
revoke all on function public.meta_spend_post(uuid, uuid, numeric, timestamptz, text, numeric, numeric, text, text) from public, anon, authenticated;
revoke all on function public.reverse_usd_purchase(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_usd_purchase(uuid, uuid, text) to service_role;
revoke all on function public.adjust_prepaid_credit(uuid, uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.adjust_prepaid_credit(uuid, uuid, text, numeric, text) to service_role;
revoke all on function public.reverse_prepaid_adjustment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_prepaid_adjustment(uuid, uuid, text) to service_role;
revoke all on function public.record_opening_bank(uuid, numeric, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_opening_bank(uuid, numeric, timestamptz, text) to service_role;
revoke all on function public.reverse_opening_bank(uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_opening_bank(uuid, text) to service_role;
revoke all on function public.record_reconciliation(uuid, text, timestamptz, numeric, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_reconciliation(uuid, text, timestamptz, numeric, jsonb, text) to service_role;
revoke all on function public.resolve_reconciliation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_reconciliation(uuid, uuid, text) to service_role;
revoke all on function public.finance_profit_report(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.finance_profit_report(timestamptz, timestamptz) to service_role;
