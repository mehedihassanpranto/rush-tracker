-- ============================================================================
-- Finance v2, Milestone 3 — Meta accounts: billing mode, daily spend,
-- prepaid lots, postpaid "owed to Meta". docs/ACCOUNTING_POLICY.md §4, §9.
--
-- Owner decisions (2026-10-20): every pool account is Meta-POSTPAID unless
-- marked otherwise; spend = the change in Meta's synced amount_spent between
-- readings (the daily cron), with manual correction; a DROP is flagged for
-- review, never booked as negative spend; postpaid cost is recognised when
-- Meta's bill is paid, at FIFO cost (spend before that is a USD-only payable).
--
--   ad_accounts.meta_billing_mode  META_POSTPAID (default) | META_PREPAID.
--                     Meta's billing — NOT clients.segment (how a client pays
--                     an agency). Only platform pool accounts are tracked.
--   meta_spend_cursors   last amount_spent reading per pool account. Seeded
--                     with today's readings: spend BEFORE tracking began is
--                     history, not booked.
--   meta_spend_events    one per positive reading change (SYNC) or manual
--                     entry (MANUAL). Prepaid: consumes the account's lots
--                     FIFO, cost recognised now. Postpaid: USD only.
--   meta_prepaid_lots    one per funding outflow (META_PREPAID_FUNDING): the
--                     dollars loaded, at their FIFO cost from inventory.
--   meta_prepaid_allocations  insert-only, like inventory_allocations.
--   meta_spend_exceptions     a reading that went DOWN, spend beyond what a
--                     prepaid account holds, a non-USD account. Reviewed and
--                     resolved by hand.
--
-- Journal (000061 posting map, extended):
--   prepaid funding   Dr 1400 Meta prepaid      Cr 1200 USD inventory
--   prepaid spend     Dr 5000 Service cost      Cr 1400   (lot FIFO cost)
--   postpaid spend    no entry (no taka moves; USD payable tracked here)
--   Meta bill paid    Dr 5000                   Cr 1200   (unchanged)
--
-- Not in this migration (documented gap): returning unspent prepaid credit to
-- inventory, or writing it off — Milestone 5.
--
-- Rows referencing an ad account use ON DELETE SET NULL: finance history
-- survives the account (as usd_sales does), and a pool account is never
-- blocked from deletion by it.
--
-- MANUAL ROLLBACK: drop the new functions, views, triggers and tables; then
--   alter table public.ad_accounts drop column meta_billing_mode; restore
--   the usd_outflows kind check, journal source_type check and the three
--   functions redefined here from 000059 / 000061.
-- ============================================================================

-- ------------------------------------------------------------ billing mode ---
alter table public.ad_accounts
  add column meta_billing_mode text not null default 'META_POSTPAID'
    check (meta_billing_mode in ('META_POSTPAID', 'META_PREPAID'));
comment on column public.ad_accounts.meta_billing_mode is
  'How META bills this account (platform finance): postpaid (Meta bills after spend) or prepaid (loaded in advance). Not clients.segment.';

-- ---------------------------------------------------------------- cursors ---
create table public.meta_spend_cursors (
  ad_account_id        uuid primary key references public.ad_accounts (id) on delete cascade,
  last_cumulative_usd  numeric(24, 6) not null,
  last_read_at         timestamptz not null,
  tracking_since       timestamptz not null default now()
);

insert into public.meta_spend_cursors (ad_account_id, last_cumulative_usd, last_read_at, tracking_since)
select id, meta_amount_spent, coalesce(meta_refreshed_at, now()), now()
from public.ad_accounts
where is_platform and meta_currency = 'USD' and meta_amount_spent is not null;

-- ----------------------------------------------------------- spend events ---
create sequence public.meta_spend_seq;

create table public.meta_spend_events (
  id              uuid primary key default gen_random_uuid(),
  reference_id    text not null unique
                    default ('SPD-' || lpad(nextval('public.meta_spend_seq')::text, 6, '0')),
  ad_account_id   uuid references public.ad_accounts (id) on delete set null,
  billing_mode    text not null check (billing_mode in ('META_POSTPAID', 'META_PREPAID')),
  usd_amount      numeric(24, 6) not null check (usd_amount > 0),
  -- Prepaid only: what the account's lots covered, and what they could not.
  covered_usd     numeric(24, 6) not null default 0 check (covered_usd >= 0),
  unfunded_usd    numeric(24, 6) not null default 0 check (unfunded_usd >= 0),
  bdt_cost        numeric(18, 2) not null default 0 check (bdt_cost >= 0),
  event_at        timestamptz not null,
  source          text not null check (source in ('SYNC', 'MANUAL')),
  reading_from    numeric(24, 6),
  reading_to      numeric(24, 6),
  idempotency_key text unique,
  status          text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversed_by     uuid references auth.users (id),
  reversed_at     timestamptz,
  reversal_reason text,
  notes           text,
  recorded_by     uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  check (covered_usd + unfunded_usd = case when billing_mode = 'META_PREPAID' then usd_amount else 0 end)
);
create index idx_meta_spend_events_account on public.meta_spend_events (ad_account_id, event_at desc);

-- ---------------------------------------------------------- prepaid lots ---
create sequence public.meta_lot_seq;

create table public.meta_prepaid_lots (
  id                 uuid primary key default gen_random_uuid(),
  ad_account_id      uuid references public.ad_accounts (id) on delete set null,
  funding_outflow_id uuid not null unique references public.usd_outflows (id),
  seq                bigint not null default nextval('public.meta_lot_seq'),
  usd                numeric(24, 6) not null check (usd > 0),
  bdt                numeric(18, 2) not null check (bdt >= 0),
  created_at         timestamptz not null default now()
);
create index idx_meta_prepaid_lots_account on public.meta_prepaid_lots (ad_account_id, seq);

create table public.meta_prepaid_allocations (
  id             uuid primary key default gen_random_uuid(),
  lot_id         uuid not null references public.meta_prepaid_lots (id),
  spend_event_id uuid not null references public.meta_spend_events (id),
  usd            numeric(24, 6) not null,
  unit_cost      numeric(18, 6) not null,
  bdt            numeric(18, 2) not null,
  is_reversal    boolean not null default false,
  created_at     timestamptz not null default now(),
  check ((not is_reversal and usd > 0 and bdt >= 0) or (is_reversal and usd < 0 and bdt <= 0))
);
create index idx_meta_prepaid_allocations_lot on public.meta_prepaid_allocations (lot_id);
create index idx_meta_prepaid_allocations_event on public.meta_prepaid_allocations (spend_event_id);

create table public.meta_spend_exceptions (
  id              uuid primary key default gen_random_uuid(),
  ad_account_id   uuid references public.ad_accounts (id) on delete set null,
  kind            text not null check (kind in ('NEGATIVE_CHANGE', 'UNFUNDED_SPEND', 'NON_USD')),
  usd             numeric(24, 6),
  details         jsonb not null default '{}'::jsonb,
  event_at        timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users (id),
  resolution_note text,
  created_at      timestamptz not null default now(),
  check ((resolved_at is null) = (resolution_note is null))
);
create index idx_meta_spend_exceptions_open on public.meta_spend_exceptions (created_at desc) where resolved_at is null;

create trigger trg_meta_prepaid_allocations_immutable
  before update or delete on public.meta_prepaid_allocations
  for each row execute function public.finance_block_mutation();
create trigger trg_meta_spend_events_no_delete
  before delete on public.meta_spend_events
  for each row execute function public.finance_block_mutation();
create trigger trg_meta_prepaid_lots_no_delete
  before delete on public.meta_prepaid_lots
  for each row execute function public.finance_block_mutation();

alter table public.meta_spend_cursors       enable row level security;
alter table public.meta_spend_events        enable row level security;
alter table public.meta_prepaid_lots        enable row level security;
alter table public.meta_prepaid_allocations enable row level security;
alter table public.meta_spend_exceptions    enable row level security;
revoke all on public.meta_spend_cursors, public.meta_spend_events, public.meta_prepaid_lots,
  public.meta_prepaid_allocations, public.meta_spend_exceptions from anon, authenticated;
revoke all on sequence public.meta_spend_seq, public.meta_lot_seq from anon, authenticated;

-- ------------------------------------------------------------------ views ---
-- A lot's remainder; it counts only while its funding outflow stands.
create view public.meta_prepaid_lot_balances
  with (security_invoker = true) as
select
  l.id as lot_id,
  l.ad_account_id,
  l.seq,
  o.status,
  l.usd,
  l.bdt,
  l.usd - coalesce(a.used_usd, 0) as left_usd,
  l.bdt - coalesce(a.used_bdt, 0) as left_bdt
from public.meta_prepaid_lots l
join public.usd_outflows o on o.id = l.funding_outflow_id
left join (
  select lot_id, sum(usd) as used_usd, sum(bdt) as used_bdt
  from public.meta_prepaid_allocations group by lot_id
) a on a.lot_id = l.id;

-- Per pool account: four separate figures (policy §4.4) and Meta's own
-- balance beside them for comparison — never a spend cap.
create view public.meta_account_positions
  with (security_invoker = true) as
select
  a.id as ad_account_id,
  a.account_code,
  a.name,
  a.status,
  a.meta_billing_mode,
  a.meta_currency,
  a.meta_balance,
  a.meta_refreshed_at,
  c.tracking_since,
  c.last_read_at,
  c.last_cumulative_usd,
  coalesce((select sum(e.usd_amount) from public.meta_spend_events e
            where e.ad_account_id = a.id and e.status = 'POSTED'), 0)                       as spent_usd,
  coalesce((select sum(l.usd) from public.meta_prepaid_lot_balances l
            where l.ad_account_id = a.id and l.status = 'POSTED'), 0)                       as funded_usd,
  coalesce((select sum(l.left_usd) from public.meta_prepaid_lot_balances l
            where l.ad_account_id = a.id and l.status = 'POSTED'), 0)                       as prepaid_left_usd,
  coalesce((select sum(l.left_bdt) from public.meta_prepaid_lot_balances l
            where l.ad_account_id = a.id and l.status = 'POSTED'), 0)                       as prepaid_left_bdt,
  coalesce((select sum(o.usd_amount) from public.usd_outflows o
            where o.ad_account_id = a.id and o.kind = 'META_BILL_PAYMENT' and o.status = 'POSTED'), 0) as paid_usd,
  -- Owed to Meta: postpaid spend tracked here, minus bills paid. Negative =
  -- paid more than tracked (e.g. a bill for spend from before tracking).
  coalesce((select sum(e.usd_amount) from public.meta_spend_events e
            where e.ad_account_id = a.id and e.status = 'POSTED' and e.billing_mode = 'META_POSTPAID'), 0)
  - coalesce((select sum(o.usd_amount) from public.usd_outflows o
              where o.ad_account_id = a.id and o.kind = 'META_BILL_PAYMENT' and o.status = 'POSTED'), 0) as owed_usd,
  (select count(*) from public.meta_spend_exceptions x
   where x.ad_account_id = a.id and x.resolved_at is null)                                  as open_exceptions
from public.ad_accounts a
left join public.meta_spend_cursors c on c.ad_account_id = a.id
where a.is_platform;

revoke all on public.meta_prepaid_lot_balances, public.meta_account_positions from anon, authenticated;

-- -------------------------------------------------- outflow kinds, journal ---
alter table public.usd_outflows drop constraint usd_outflows_kind_check;
alter table public.usd_outflows add constraint usd_outflows_kind_check
  check (kind in ('META_BILL_PAYMENT', 'META_PREPAID_FUNDING', 'OPENING_ADJUSTMENT', 'OTHER'));

alter table public.journal_entries drop constraint journal_entries_source_type_check;
alter table public.journal_entries add constraint journal_entries_source_type_check
  check (source_type in ('USD_PURCHASE', 'USD_OUTFLOW', 'USD_SALE', 'USD_SALE_RECEIPT', 'META_SPEND', 'MANUAL'));

create or replace function public.journal_post_outflow(o public.usd_outflows)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_debit text := case o.kind
    when 'META_BILL_PAYMENT' then '5000'
    when 'META_PREPAID_FUNDING' then '1400'
    when 'OPENING_ADJUSTMENT' then '3000'
    else '5900' end;
  v_account text;
begin
  select account_code || ' · ' || name into v_account from public.ad_accounts where id = o.ad_account_id;
  return public.journal_post(
    'USD_OUTFLOW', o.id, o.event_at,
    o.reference_id || ' — ' || case o.kind
      when 'META_BILL_PAYMENT' then 'Meta bill paid' || coalesce(', ' || v_account, '')
      when 'META_PREPAID_FUNDING' then 'Prepaid Meta funding' || coalesce(', ' || v_account, '')
      when 'OPENING_ADJUSTMENT' then 'USD used before Finance v2'
      else coalesce(o.notes, 'USD paid out') end,
    o.recorded_by,
    jsonb_build_array(
      jsonb_build_object('account', v_debit, 'debit', o.bdt_cost, 'usd', o.usd_amount),
      jsonb_build_object('account', '1200', 'credit', o.bdt_cost, 'usd', o.usd_amount, 'memo', 'FIFO cost')));
end;
$$;

-- Prepaid spend only: postpaid spend moves no taka (cost comes at the bill).
create or replace function public.journal_post_meta_spend(e public.meta_spend_events)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account text;
begin
  if e.bdt_cost <= 0 then return null; end if;
  select account_code || ' · ' || name into v_account from public.ad_accounts where id = e.ad_account_id;
  return public.journal_post(
    'META_SPEND', e.id, e.event_at,
    e.reference_id || ' — prepaid Meta spend' || coalesce(', ' || v_account, ''),
    e.recorded_by,
    jsonb_build_array(
      jsonb_build_object('account', '5000', 'debit', e.bdt_cost, 'usd', e.covered_usd),
      jsonb_build_object('account', '1400', 'credit', e.bdt_cost, 'usd', e.covered_usd, 'memo', 'Prepaid lot FIFO cost')));
end;
$$;

-- Deferred like the outflow trigger: the spend RPC sets bdt_cost after
-- consuming lots, in the same transaction.
create or replace function public.trg_journal_meta_spend_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.meta_spend_events;
begin
  if exists (select 1 from public.journal_entries
             where source_type = 'META_SPEND' and source_id = new.id and not is_reversal) then
    return null;
  end if;
  select * into v_row from public.meta_spend_events where id = new.id;
  perform public.journal_post_meta_spend(v_row);
  return null;
end;
$$;
create constraint trigger trg_meta_spend_events_journal
  after insert on public.meta_spend_events
  deferrable initially deferred
  for each row execute function public.trg_journal_meta_spend_insert();

create or replace function public.trg_journal_meta_spend_reversed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'REVERSED' and old.status = 'POSTED' and new.bdt_cost > 0 then
    if not exists (select 1 from public.journal_entries
                   where source_type = 'META_SPEND' and source_id = new.id and not is_reversal) then
      perform public.journal_post_meta_spend(new);
    end if;
    perform public.journal_reverse('META_SPEND', new.id, new.reversed_at, new.reversal_reason, new.reversed_by);
  end if;
  return null;
end;
$$;
create trigger trg_meta_spend_events_journal_reversed
  after update of status on public.meta_spend_events
  for each row execute function public.trg_journal_meta_spend_reversed();

-- --------------------------------------------------- outflows, redefined ---
-- 000059's post_usd_outflow + META_PREPAID_FUNDING: draws FIFO from
-- inventory exactly as before, then turns what it drew into one lot on the
-- account at the same cost. Same signature.
create or replace function public.post_usd_outflow(
  p_actor           uuid,
  p_kind            text,
  p_usd             numeric,
  p_event_at        timestamptz,
  p_ad_account_id   uuid,
  p_idempotency_key text,
  p_notes           text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.usd_outflows;
  v_out      public.usd_outflows;
  v_key      text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_need     numeric;
  v_take     numeric;
  v_cost     numeric;
  v_total    numeric := 0;
  v_avail    numeric;
  v_mode     text;
  b          record;
begin
  perform public.finance_v2_lock();

  if v_key is not null then
    select * into v_existing from public.usd_outflows where idempotency_key = v_key;
    if found then return to_jsonb(v_existing) || jsonb_build_object('duplicate', true); end if;
  end if;

  if p_kind not in ('META_BILL_PAYMENT', 'META_PREPAID_FUNDING', 'OPENING_ADJUSTMENT', 'OTHER') then
    raise exception 'INVALID_KIND: Unknown outflow type';
  end if;
  if p_usd is null or p_usd <= 0 or p_usd <> round(p_usd, 2) then
    raise exception 'INVALID_AMOUNT: Enter a USD amount greater than zero, to the cent';
  end if;
  if p_kind in ('META_BILL_PAYMENT', 'META_PREPAID_FUNDING') then
    select meta_billing_mode into v_mode from public.ad_accounts
      where id = p_ad_account_id and is_platform;
    if p_ad_account_id is null or not found then
      raise exception 'NOT_FOUND: Choose the platform ad account';
    end if;
    if p_kind = 'META_PREPAID_FUNDING' and v_mode <> 'META_PREPAID' then
      raise exception 'NOT_PREPAID: Only a prepaid Meta account can be funded — set its billing to prepaid first';
    end if;
  elsif nullif(btrim(coalesce(p_notes, '')), '') is null then
    raise exception 'NOTE_REQUIRED: Say what this outflow was';
  end if;

  select coalesce(sum(left_usd), 0) into v_avail
  from public.usd_batch_balances where status = 'POSTED';
  if v_avail < p_usd then
    raise exception 'INSUFFICIENT_INVENTORY: Needs % USD, only % USD in stock', p_usd, round(v_avail, 2);
  end if;

  insert into public.usd_outflows (kind, ad_account_id, usd_amount, event_at, idempotency_key, notes, recorded_by)
  values (p_kind, case when p_kind in ('META_BILL_PAYMENT', 'META_PREPAID_FUNDING') then p_ad_account_id end,
          p_usd, p_event_at, v_key, nullif(btrim(coalesce(p_notes, '')), ''), p_actor)
  returning * into v_out;

  v_need := p_usd;
  for b in
    select batch_id, left_usd, left_bdt from public.usd_batch_balances
    where status = 'POSTED' and left_usd > 0
    order by posting_seq, batch_id
  loop
    exit when v_need <= 0;
    v_take := least(b.left_usd, v_need);
    v_cost := case when v_take = b.left_usd then b.left_bdt
                   else round(v_take * b.left_bdt / b.left_usd, 2) end;
    insert into public.inventory_allocations (batch_id, outflow_id, usd, unit_cost, bdt)
    values (b.batch_id, v_out.id, v_take, round(b.left_bdt / b.left_usd, 6), v_cost);
    v_need := v_need - v_take;
    v_total := v_total + v_cost;
  end loop;

  update public.usd_outflows set bdt_cost = v_total where id = v_out.id returning * into v_out;

  if p_kind = 'META_PREPAID_FUNDING' then
    insert into public.meta_prepaid_lots (ad_account_id, funding_outflow_id, usd, bdt)
    values (p_ad_account_id, v_out.id, p_usd, v_total);
  end if;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'USD_OUTFLOW_POSTED', 'USD_OUTFLOW', v_out.id, jsonb_build_object(
    'kind', p_kind, 'usd', p_usd, 'bdt_cost', v_total, 'ad_account_id', p_ad_account_id));

  return to_jsonb(v_out) || jsonb_build_object('duplicate', false);
end;
$$;

-- 000059's reverse_usd_outflow + a funding outflow is reversible only while
-- none of its lot has been spent.
create or replace function public.reverse_usd_outflow(p_actor uuid, p_outflow_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out  public.usd_outflows;
  v_used numeric;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Give a reason for the reversal';
  end if;
  select * into v_out from public.usd_outflows where id = p_outflow_id for update;
  if not found then raise exception 'NOT_FOUND: Outflow not found'; end if;
  if v_out.status <> 'POSTED' then raise exception 'ALREADY_REVERSED: This outflow is already reversed'; end if;
  if v_out.kind = 'META_PREPAID_FUNDING' then
    select usd - left_usd into v_used from public.meta_prepaid_lot_balances
      where lot_id = (select id from public.meta_prepaid_lots where funding_outflow_id = p_outflow_id);
    if coalesce(v_used, 0) <> 0 then
      raise exception 'LOT_IN_USE: % USD of this funding has been spent; reverse that spend first', round(v_used, 2);
    end if;
  end if;

  insert into public.inventory_allocations (batch_id, outflow_id, usd, unit_cost, bdt, is_reversal)
  select batch_id, outflow_id, -usd, unit_cost, -bdt, true
  from public.inventory_allocations
  where outflow_id = p_outflow_id and not is_reversal;

  update public.usd_outflows
  set status = 'REVERSED', reversed_by = p_actor, reversed_at = now(), reversal_reason = btrim(p_reason)
  where id = p_outflow_id
  returning * into v_out;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'USD_OUTFLOW_REVERSED', 'USD_OUTFLOW', p_outflow_id, jsonb_build_object('reason', btrim(p_reason)));
  return to_jsonb(v_out);
end;
$$;

-- ------------------------------------------------------------- spend RPCs ---
-- Internal: record one spend event (caller holds the lock and validated the
-- account). Prepaid consumes the account's lots oldest-first with the same
-- rounding as inventory FIFO; what the lots can't cover is flagged.
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
  v_ev     public.meta_spend_events;
  v_need   numeric;
  v_take   numeric;
  v_cost   numeric;
  v_total  numeric := 0;
  v_cover  numeric := 0;
  l        record;
begin
  select meta_billing_mode into v_mode from public.ad_accounts where id = p_account;

  insert into public.meta_spend_events (
    ad_account_id, billing_mode, usd_amount, covered_usd, unfunded_usd, event_at, source,
    reading_from, reading_to, notes, idempotency_key, recorded_by)
  -- Prepaid starts fully unfunded and is re-split once the lots are consumed.
  values (p_account, v_mode, p_usd,
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
    'bdt_cost', v_ev.bdt_cost, 'unfunded_usd', v_ev.unfunded_usd));
  return v_ev;
end;
$$;

-- The daily reading (cron, or "Read spend now"): for every platform pool
-- account with a fresh USD reading, post the change since the last one.
-- First reading = baseline. A drop = exception + re-baseline. Non-USD =
-- exception once (money comparisons are USD-only).
create or replace function public.record_meta_spend_readings(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a        record;
  v_cur    public.meta_spend_cursors;
  v_delta  numeric;
  v_posted integer := 0;
  v_base   integer := 0;
  v_flag   integer := 0;
  v_usd    numeric := 0;
begin
  perform public.finance_v2_lock();
  for a in
    select id, meta_amount_spent, meta_currency, meta_refreshed_at
    from public.ad_accounts
    where is_platform and meta_amount_spent is not null and meta_refreshed_at is not null
    order by id
  loop
    if a.meta_currency is distinct from 'USD' then
      if not exists (select 1 from public.meta_spend_exceptions
                     where ad_account_id = a.id and kind = 'NON_USD' and resolved_at is null) then
        insert into public.meta_spend_exceptions (ad_account_id, kind, details)
        values (a.id, 'NON_USD', jsonb_build_object('currency', a.meta_currency));
        v_flag := v_flag + 1;
      end if;
      continue;
    end if;

    select * into v_cur from public.meta_spend_cursors where ad_account_id = a.id for update;
    if not found then
      insert into public.meta_spend_cursors (ad_account_id, last_cumulative_usd, last_read_at)
      values (a.id, a.meta_amount_spent, a.meta_refreshed_at);
      v_base := v_base + 1;
      continue;
    end if;
    if a.meta_refreshed_at <= v_cur.last_read_at then
      continue; -- no new reading since the last one
    end if;

    v_delta := a.meta_amount_spent - v_cur.last_cumulative_usd;
    if v_delta < 0 then
      insert into public.meta_spend_exceptions (ad_account_id, kind, usd, details, event_at)
      values (a.id, 'NEGATIVE_CHANGE', -v_delta,
              jsonb_build_object('from', v_cur.last_cumulative_usd, 'to', a.meta_amount_spent),
              a.meta_refreshed_at);
      v_flag := v_flag + 1;
    elsif v_delta > 0 then
      perform public.meta_spend_post(p_actor, a.id, v_delta, a.meta_refreshed_at, 'SYNC',
                                     v_cur.last_cumulative_usd, a.meta_amount_spent, null, null);
      v_posted := v_posted + 1;
      v_usd := v_usd + v_delta;
    end if;

    update public.meta_spend_cursors
    set last_cumulative_usd = a.meta_amount_spent, last_read_at = a.meta_refreshed_at
    where ad_account_id = a.id;
  end loop;

  return jsonb_build_object('posted', v_posted, 'spend_usd', v_usd, 'baselined', v_base, 'flagged', v_flag);
end;
$$;

-- A spend entered by hand (a correction after a flagged drop, or spend the
-- sync can't see). Does not move the cursor.
create or replace function public.record_manual_meta_spend(
  p_actor   uuid,
  p_account uuid,
  p_usd     numeric,
  p_event_at timestamptz,
  p_notes   text,
  p_key     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.meta_spend_events;
  v_ev       public.meta_spend_events;
  v_key      text := nullif(btrim(coalesce(p_key, '')), '');
begin
  perform public.finance_v2_lock();
  if v_key is not null then
    select * into v_existing from public.meta_spend_events where idempotency_key = v_key;
    if found then return to_jsonb(v_existing) || jsonb_build_object('duplicate', true); end if;
  end if;
  if not exists (select 1 from public.ad_accounts where id = p_account and is_platform) then
    raise exception 'NOT_FOUND: Choose a platform ad account';
  end if;
  if p_usd is null or p_usd <= 0 or p_usd <> round(p_usd, 2) then
    raise exception 'INVALID_AMOUNT: Enter a USD amount greater than zero, to the cent';
  end if;
  if nullif(btrim(coalesce(p_notes, '')), '') is null then
    raise exception 'NOTE_REQUIRED: Say why this spend is entered by hand';
  end if;
  v_ev := public.meta_spend_post(p_actor, p_account, p_usd, p_event_at, 'MANUAL', null, null, p_notes, v_key);
  return to_jsonb(v_ev) || jsonb_build_object('duplicate', false);
end;
$$;

-- Undo a spend event: prepaid allocations are mirrored back into the lots.
create or replace function public.reverse_meta_spend(p_actor uuid, p_event uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev public.meta_spend_events;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Give a reason for the reversal';
  end if;
  select * into v_ev from public.meta_spend_events where id = p_event for update;
  if not found then raise exception 'NOT_FOUND: Spend not found'; end if;
  if v_ev.status <> 'POSTED' then raise exception 'ALREADY_REVERSED: This spend is already reversed'; end if;

  insert into public.meta_prepaid_allocations (lot_id, spend_event_id, usd, unit_cost, bdt, is_reversal)
  select lot_id, spend_event_id, -usd, unit_cost, -bdt, true
  from public.meta_prepaid_allocations where spend_event_id = p_event and not is_reversal;

  update public.meta_spend_events
  set status = 'REVERSED', reversed_by = p_actor, reversed_at = now(), reversal_reason = btrim(p_reason)
  where id = p_event
  returning * into v_ev;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'META_SPEND_REVERSED', 'META_SPEND', p_event, jsonb_build_object('reason', btrim(p_reason)));
  return to_jsonb(v_ev);
end;
$$;

-- Prepaid → postpaid only once the account's lots are empty: unspent prepaid
-- dollars would otherwise be stranded (there is no return path until M5).
create or replace function public.set_meta_billing_mode(p_actor uuid, p_account uuid, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old  text;
  v_left numeric;
begin
  perform public.finance_v2_lock();
  if p_mode not in ('META_POSTPAID', 'META_PREPAID') then
    raise exception 'INVALID_MODE: Unknown billing mode';
  end if;
  select meta_billing_mode into v_old from public.ad_accounts where id = p_account and is_platform for update;
  if not found then raise exception 'NOT_FOUND: Choose a platform ad account'; end if;
  if v_old = p_mode then return jsonb_build_object('mode', p_mode, 'changed', false); end if;
  if p_mode = 'META_POSTPAID' then
    select coalesce(sum(left_usd), 0) into v_left from public.meta_prepaid_lot_balances
      where ad_account_id = p_account and status = 'POSTED';
    if v_left > 0 then
      raise exception 'PREPAID_LEFT: % USD of prepaid credit is still on this account — it must be spent first', round(v_left, 2);
    end if;
  end if;
  update public.ad_accounts set meta_billing_mode = p_mode where id = p_account;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'META_BILLING_MODE_SET', 'AD_ACCOUNT', p_account, jsonb_build_object('from', v_old, 'to', p_mode));
  return jsonb_build_object('mode', p_mode, 'changed', true);
end;
$$;

create or replace function public.resolve_meta_spend_exception(p_actor uuid, p_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_x public.meta_spend_exceptions;
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'REASON_REQUIRED: Say how this was resolved';
  end if;
  update public.meta_spend_exceptions
  set resolved_at = now(), resolved_by = p_actor, resolution_note = btrim(p_note)
  where id = p_id and resolved_at is null
  returning * into v_x;
  if not found then raise exception 'NOT_FOUND: Exception not found or already resolved'; end if;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'META_SPEND_EXCEPTION_RESOLVED', 'META_SPEND_EXCEPTION', p_id, jsonb_build_object('note', btrim(p_note)));
  return to_jsonb(v_x);
end;
$$;

-- ----------------------------------------------------------------- grants ---
revoke all on function public.journal_post_meta_spend(public.meta_spend_events) from public, anon, authenticated;
revoke all on function public.trg_journal_meta_spend_insert() from public, anon, authenticated;
revoke all on function public.trg_journal_meta_spend_reversed() from public, anon, authenticated;
revoke all on function public.journal_post_outflow(public.usd_outflows) from public, anon, authenticated;
revoke all on function public.meta_spend_post(uuid, uuid, numeric, timestamptz, text, numeric, numeric, text, text) from public, anon, authenticated;
revoke all on function public.post_usd_outflow(uuid, text, numeric, timestamptz, uuid, text, text) from public, anon, authenticated;
grant execute on function public.post_usd_outflow(uuid, text, numeric, timestamptz, uuid, text, text) to service_role;
revoke all on function public.reverse_usd_outflow(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_usd_outflow(uuid, uuid, text) to service_role;
revoke all on function public.record_meta_spend_readings(uuid) from public, anon, authenticated;
grant execute on function public.record_meta_spend_readings(uuid) to service_role;
revoke all on function public.record_manual_meta_spend(uuid, uuid, numeric, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.record_manual_meta_spend(uuid, uuid, numeric, timestamptz, text, text) to service_role;
revoke all on function public.reverse_meta_spend(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_meta_spend(uuid, uuid, text) to service_role;
revoke all on function public.set_meta_billing_mode(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_meta_billing_mode(uuid, uuid, text) to service_role;
revoke all on function public.resolve_meta_spend_exception(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_meta_spend_exception(uuid, uuid, text) to service_role;
