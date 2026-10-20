-- ============================================================================
-- Finance v2, Milestone 1 — FIFO USD inventory with transfer fees.
-- docs/ACCOUNTING_POLICY.md, docs/FINANCE_V2_MILESTONE0.md. Owner approved the
-- plan's defaults and the Milestone 0 suggestions on 2026-10-20.
--
-- The PLATFORM's book only (no organization_id anywhere here — the agency
-- book comes later and adds a nullable organization_id, NULL = platform).
--
--   usd_sources       + receiving_institution, default_rate (suppliers)
--   fee_rules         effective-dated automatic fees, seeded with the owner's
--                     DBBL→DBBL 0 / NPSB 10 / Binance 0.01 rules
--   usd_purchases     + gross/net USD, fee snapshot, capitalized fees, rates,
--                     posting_seq, status — each row is now a FIFO batch.
--                     bdt_amount keeps meaning "what the dollars cost in BDT",
--                     now INCLUDING the fees you bear, so the existing
--                     weighted-average usd_stock_summary stays coherent.
--   usd_outflows      USD leaving inventory (a Meta bill paid, the opening
--                     cut-over adjustment, other). NOT usd_sales: under the
--                     owner's model a sale to an agency is revenue, and the
--                     dollars leave stock when Meta's bill is paid.
--   inventory_allocations  which batch each outflow drew from, at what cost.
--                     Insert-only; a reversal inserts mirror rows.
--   platform_finance_audit insert-only. audit_logs can't be used: org zero is
--                     also xRush Agency, whose admins read that log.
--
-- Backfill: every existing purchase becomes an opening batch (gross = net =
-- usd_amount, cost = bdt_amount, no fees), posting order = purchased_at,
-- created_at, id. No existing value is changed; only the new columns fill.
-- Until the owner records the opening adjustment (USD actually on hand at
-- cut-over), the FIFO inventory counts every dollar ever bought.
--
-- Concurrency: every inventory write takes one transaction-scoped advisory
-- lock, so two postings can never draw the same dollars.
--
-- Access: RLS on with zero policies, all grants revoked from anon /
-- authenticated, views security_invoker, functions service_role only
-- (migrations 000041, 000050–52). Service layer: requirePlatformAdmin().
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   drop function public.post_usd_purchase, public.post_usd_outflow,
--     public.reverse_usd_outflow, public.reverse_usd_purchase,
--     public.finance_v2_lock, public.finance_block_mutation,
--     public.usd_purchase_fill_batch_fields (drop its trigger first);
--   drop view public.usd_fifo_summary, public.usd_batch_balances;
--   drop table public.inventory_allocations, public.usd_outflows,
--     public.platform_finance_audit, public.fee_rules;
--   drop sequence public.usd_outflow_seq, public.usd_posting_seq;
--   alter table public.usd_purchases drop column gross_usd, …(see below);
--   alter table public.usd_sources drop column receiving_institution,
--     drop column default_rate;
--   then recreate usd_stock_summary from 000041.
-- ============================================================================

-- --------------------------------------------------------------- suppliers ---
alter table public.usd_sources
  add column receiving_institution text,
  add column default_rate numeric(18, 6) check (default_rate is null or default_rate > 0);
comment on column public.usd_sources.receiving_institution is
  'Bank code the supplier is paid into (DBBL, BRAC, …). Decides the bank fee route. NULL = not set; a purchase is refused until it is.';

-- --------------------------------------------------------------- fee rules ---
create table public.fee_rules (
  id               uuid primary key default gen_random_uuid(),
  code             text not null check (length(btrim(code)) > 0),
  channel          text not null check (channel in ('BANK_INTERNAL', 'NPSB', 'BINANCE', 'PAYONEER')),
  from_institution text not null default '*',
  to_institution   text not null default '*',
  fee_type         text not null check (fee_type in ('FIXED', 'PERCENT', 'TIERED')),
  amount           numeric(18, 6) check (amount is null or amount >= 0),
  percent          numeric(9, 6) check (percent is null or percent >= 0),
  tiers            jsonb,
  currency         text not null check (currency in ('BDT', 'USD')),
  your_share_pct   numeric(5, 2) not null default 100 check (your_share_pct between 0 and 100),
  effective_from   date not null,
  effective_to     date check (effective_to is null or effective_to >= effective_from),
  notes            text,
  created_by       uuid references auth.users (id),
  created_at       timestamptz not null default now(),
  check (
    (fee_type = 'FIXED' and amount is not null)
    or (fee_type = 'PERCENT' and percent is not null)
    or (fee_type = 'TIERED' and jsonb_typeof(tiers) = 'array')
  )
);
create index idx_fee_rules_channel on public.fee_rules (channel, effective_from);

insert into public.fee_rules
  (code, channel, from_institution, to_institution, fee_type, amount, currency, your_share_pct, effective_from, notes)
values
  ('dbbl-internal', 'BANK_INTERNAL', 'DBBL', 'DBBL', 'FIXED', 0, 'BDT', 100, '2020-01-01', 'Dutch-Bangla to Dutch-Bangla is free (owner, 2026-10-20)'),
  ('npsb-flat', 'NPSB', '*', '*', 'FIXED', 10, 'BDT', 100, '2020-01-01', 'Any NPSB transfer to another bank, BDT 10 flat, you bear it (owner, 2026-10-20)'),
  ('binance-transfer', 'BINANCE', '*', '*', 'FIXED', 0.01, 'USD', 100, '2020-01-01', 'USD 0.01 per transfer, once, you bear it (owner, 2026-10-20)');

-- --------------------------------------------------------------- batches ---
create sequence public.usd_posting_seq;

alter table public.usd_purchases
  add column gross_usd            numeric(24, 6),
  add column net_usd              numeric(24, 6),
  add column bdt_principal        numeric(18, 2),
  add column fees                 jsonb not null default '[]'::jsonb,
  add column capitalized_fees_bdt numeric(18, 2) not null default 0,
  add column supplier_rate        numeric(18, 6),
  add column effective_rate       numeric(18, 6),
  add column rate_warning         boolean not null default false,
  add column posting_seq          bigint,
  add column external_reference   text,
  add column is_opening           boolean not null default false,
  add column status               text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  add column reversed_by          uuid references auth.users (id),
  add column reversed_at          timestamptz,
  add column reversal_reason      text;

with ordered as (
  select id, row_number() over (order by purchased_at, created_at, id) as seq
  from public.usd_purchases
)
update public.usd_purchases p
set gross_usd      = p.usd_amount,
    net_usd        = p.usd_amount,
    bdt_principal  = p.bdt_amount,
    supplier_rate  = round(p.bdt_amount / p.usd_amount, 6),
    effective_rate = round(p.bdt_amount / p.usd_amount, 6),
    posting_seq    = o.seq,
    is_opening     = true
from ordered o
where o.id = p.id;

select setval('public.usd_posting_seq', coalesce((select max(posting_seq) from public.usd_purchases), 0) + 1, false);

alter table public.usd_purchases
  alter column gross_usd set not null,
  alter column net_usd set not null,
  alter column bdt_principal set not null,
  alter column supplier_rate set not null,
  alter column effective_rate set not null,
  alter column posting_seq set not null,
  alter column posting_seq set default nextval('public.usd_posting_seq'),
  add constraint usd_purchases_net_le_gross check (net_usd > 0 and net_usd <= gross_usd),
  -- usd_amount / bdt_amount stay the figures the 000041 views read.
  add constraint usd_purchases_net_is_usd_amount check (net_usd = usd_amount),
  add constraint usd_purchases_cost_is_bdt_amount check (bdt_amount = bdt_principal + capitalized_fees_bdt),
  add constraint usd_purchases_reversal_fields check (
    (status = 'POSTED' and reversed_at is null) or (status = 'REVERSED' and reversed_at is not null)
  );
create unique index uq_usd_purchases_posting_seq on public.usd_purchases (posting_seq);

-- A plain insert (usd_amount + bdt_amount only, the pre-v2 shape) is a
-- fee-less batch: fill the v2 fields from the two amounts. The app posts
-- through post_usd_purchase(); this keeps any other service-role insert valid.
create or replace function public.usd_purchase_fill_batch_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.gross_usd is null then
    new.gross_usd := new.usd_amount;
    new.net_usd := new.usd_amount;
    new.bdt_principal := new.bdt_amount;
    if new.usd_amount > 0 then
      new.supplier_rate := round(new.bdt_amount / new.usd_amount, 6);
      new.effective_rate := new.supplier_rate;
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_usd_purchase_fill_batch_fields
  before insert on public.usd_purchases
  for each row execute function public.usd_purchase_fill_batch_fields();
revoke all on function public.usd_purchase_fill_batch_fields() from public, anon, authenticated;
-- A duplicate transfer reference from the same supplier is the same purchase.
create unique index uq_usd_purchases_reference
  on public.usd_purchases (source_id, lower(btrim(external_reference)))
  where external_reference is not null;

-- ------------------------------------------------------------- outflows ---
create sequence public.usd_outflow_seq;

create table public.usd_outflows (
  id              uuid primary key default gen_random_uuid(),
  reference_id    text not null unique
                    default ('OUT-' || lpad(nextval('public.usd_outflow_seq')::text, 6, '0')),
  kind            text not null check (kind in ('META_BILL_PAYMENT', 'OPENING_ADJUSTMENT', 'OTHER')),
  ad_account_id   uuid references public.ad_accounts (id) on delete set null,
  usd_amount      numeric(24, 6) not null check (usd_amount > 0),
  bdt_cost        numeric(18, 2) not null default 0,
  event_at        timestamptz not null,
  idempotency_key text unique,
  status          text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  reversed_by     uuid references auth.users (id),
  reversed_at     timestamptz,
  reversal_reason text,
  notes           text,
  recorded_by     uuid references auth.users (id),
  created_at      timestamptz not null default now()
);
create index idx_usd_outflows_event on public.usd_outflows (event_at desc);
create index idx_usd_outflows_account on public.usd_outflows (ad_account_id);

create table public.inventory_allocations (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references public.usd_purchases (id),
  outflow_id  uuid not null references public.usd_outflows (id),
  usd         numeric(24, 6) not null,
  unit_cost   numeric(18, 6) not null,
  bdt         numeric(18, 2) not null,
  is_reversal boolean not null default false,
  created_at  timestamptz not null default now(),
  check ((not is_reversal and usd > 0 and bdt >= 0) or (is_reversal and usd < 0 and bdt <= 0))
);
create index idx_inventory_allocations_batch on public.inventory_allocations (batch_id);
create index idx_inventory_allocations_outflow on public.inventory_allocations (outflow_id);

create table public.platform_finance_audit (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id),
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  new_values  jsonb,
  created_at  timestamptz not null default now()
);
create index idx_platform_finance_audit_entity on public.platform_finance_audit (entity_type, entity_id);

-- Insert-only, enforced below the grants too (the service role bypasses RLS
-- but not triggers).
create or replace function public.finance_block_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'IMMUTABLE: % rows cannot be changed or deleted; post a reversal instead', tg_table_name;
end;
$$;
create trigger trg_inventory_allocations_immutable
  before update or delete on public.inventory_allocations
  for each row execute function public.finance_block_mutation();
create trigger trg_platform_finance_audit_immutable
  before update or delete on public.platform_finance_audit
  for each row execute function public.finance_block_mutation();

-- ---------------------------------------------------------------- access ---
alter table public.fee_rules              enable row level security;
alter table public.usd_outflows           enable row level security;
alter table public.inventory_allocations  enable row level security;
alter table public.platform_finance_audit enable row level security;
revoke all on public.fee_rules, public.usd_outflows, public.inventory_allocations,
  public.platform_finance_audit from anon, authenticated;
revoke all on sequence public.usd_posting_seq, public.usd_outflow_seq from anon, authenticated;

-- ----------------------------------------------------------------- views ---
-- Weighted-average summary (000041), now ignoring reversed purchases. Same
-- columns, same order.
create or replace view public.usd_stock_summary
  with (security_invoker = true) as
with purchase_totals as (
  select
    coalesce(sum(usd_amount), 0) as total_usd_purchased,
    coalesce(sum(bdt_amount), 0) as total_bdt_invested
  from public.usd_purchases
  where status = 'POSTED'
),
sale_totals as (
  select
    coalesce(sum(usd_amount), 0) as total_usd_sold,
    coalesce(sum(bdt_amount), 0) as total_bdt_received
  from public.usd_sales
)
select
  p.total_usd_purchased,
  p.total_bdt_invested,
  s.total_usd_sold,
  s.total_bdt_received,
  p.total_usd_purchased - s.total_usd_sold as remaining_usd_stock,
  p.total_bdt_invested / nullif(p.total_usd_purchased, 0) as avg_buying_rate,
  s.total_bdt_received / nullif(s.total_usd_sold, 0) as avg_selling_rate,
  (p.total_usd_purchased - s.total_usd_sold)
    * (p.total_bdt_invested / nullif(p.total_usd_purchased, 0)) as remaining_stock_bdt_value,
  s.total_bdt_received
    - s.total_usd_sold * (p.total_bdt_invested / nullif(p.total_usd_purchased, 0)) as gross_bdt_difference
from purchase_totals p, sale_totals s;

-- What is left of each batch. left = net − Σ allocations (reversal rows are
-- negative, so a reversed outflow puts its dollars back).
create view public.usd_batch_balances
  with (security_invoker = true) as
select
  p.id as batch_id,
  p.source_id,
  p.posting_seq,
  p.purchased_at,
  p.status,
  p.net_usd,
  p.bdt_amount as total_bdt_cost,
  coalesce(a.used_usd, 0)                  as used_usd,
  coalesce(a.used_bdt, 0)                  as used_bdt,
  p.net_usd - coalesce(a.used_usd, 0)      as left_usd,
  p.bdt_amount - coalesce(a.used_bdt, 0)   as left_bdt
from public.usd_purchases p
left join (
  select batch_id, sum(usd) as used_usd, sum(bdt) as used_bdt
  from public.inventory_allocations
  group by batch_id
) a on a.batch_id = p.id;

create view public.usd_fifo_summary
  with (security_invoker = true) as
select
  coalesce(sum(left_usd) filter (where status = 'POSTED'), 0)        as left_usd,
  coalesce(sum(left_bdt) filter (where status = 'POSTED'), 0)        as left_bdt,
  count(*) filter (where status = 'POSTED' and left_usd > 0)         as open_batches,
  (select coalesce(sum(usd_amount), 0) from public.usd_outflows where status = 'POSTED') as out_usd,
  (select coalesce(sum(bdt_cost), 0) from public.usd_outflows where status = 'POSTED')   as out_bdt
from public.usd_batch_balances;

revoke all on public.usd_stock_summary, public.usd_batch_balances, public.usd_fifo_summary
  from anon, authenticated;

-- ------------------------------------------------------------- functions ---
create or replace function public.finance_v2_lock()
returns void
language sql
set search_path = public
as $$ select pg_advisory_xact_lock(hashtext('rush.usd_inventory')) $$;

-- Record a purchase as a FIFO batch. The database computes net USD, rates and
-- capitalized fees from the inputs itself (src/lib/finance/usd-batch.ts is the
-- same math, for the preview; PRICING_BASIS 'net'). p_fees is the snapshot of
-- every resolved fee: [{source, rule_id, currency, total, your_share,
-- counterparty_share, rule_total, reason}].
create or replace function public.post_usd_purchase(
  p_actor              uuid,
  p_source_id          uuid,
  p_gross_usd          numeric,
  p_bdt_principal      numeric,
  p_fees               jsonb,
  p_purchased_at       timestamptz,
  p_method             text,
  p_external_reference text,
  p_notes              text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source      public.usd_sources;
  v_existing    public.usd_purchases;
  v_row         public.usd_purchases;
  v_fee         jsonb;
  v_usd_deduct  numeric := 0;
  v_cap         numeric := 0;
  v_net         numeric;
  v_rate        numeric;
  v_later       record;
  v_ref         text := nullif(btrim(coalesce(p_external_reference, '')), '');
begin
  perform public.finance_v2_lock();

  select * into v_source from public.usd_sources where id = p_source_id;
  if not found then raise exception 'NOT_FOUND: Source not found'; end if;
  if not v_source.is_active then
    raise exception 'SOURCE_INACTIVE: That source is deactivated — reactivate it before recording a purchase';
  end if;

  if v_ref is not null then
    select * into v_existing from public.usd_purchases
      where source_id = p_source_id and lower(btrim(external_reference)) = lower(v_ref);
    if found then
      return to_jsonb(v_existing) || jsonb_build_object('duplicate', true);
    end if;
  end if;

  if p_gross_usd is null or p_gross_usd <= 0 or p_gross_usd <> round(p_gross_usd, 2) then
    raise exception 'INVALID_AMOUNT: Enter the USD sent, to the cent';
  end if;
  if p_bdt_principal is null or p_bdt_principal <= 0 or p_bdt_principal <> round(p_bdt_principal, 2) then
    raise exception 'INVALID_AMOUNT: Enter the BDT paid, to the paisa';
  end if;
  if p_purchased_at is null then
    raise exception 'INVALID_DATE: Enter when the purchase happened';
  end if;
  if jsonb_typeof(coalesce(p_fees, '[]'::jsonb)) <> 'array' then
    raise exception 'FEE_INVALID: fees must be a list';
  end if;

  for v_fee in select * from jsonb_array_elements(coalesce(p_fees, '[]'::jsonb)) loop
    if v_fee->>'currency' not in ('BDT', 'USD') or v_fee->>'source' not in ('RULE', 'MANUAL') then
      raise exception 'FEE_INVALID: unknown fee currency or source';
    end if;
    if (v_fee->>'total')::numeric < 0
       or (v_fee->>'your_share')::numeric < 0
       or (v_fee->>'your_share')::numeric > (v_fee->>'total')::numeric then
      raise exception 'FEE_INVALID: your share must be between 0 and the total fee';
    end if;
    if (v_fee->>'total')::numeric - (v_fee->>'your_share')::numeric
       <> coalesce((v_fee->>'counterparty_share')::numeric, -1) then
      raise exception 'FEE_INVALID: shares must add up to the total';
    end if;
    if (v_fee->>'source' = 'MANUAL'
        or (v_fee->>'rule_total')::numeric is distinct from (v_fee->>'total')::numeric)
       and nullif(btrim(coalesce(v_fee->>'reason', '')), '') is null then
      raise exception 'FEE_INVALID: a manual or overridden fee needs a reason';
    end if;
    if v_fee->>'currency' = 'USD' then
      v_usd_deduct := v_usd_deduct + (v_fee->>'total')::numeric;
    else
      v_cap := v_cap + (v_fee->>'your_share')::numeric;
    end if;
  end loop;

  v_net := p_gross_usd - v_usd_deduct;
  if v_net <= 0 then raise exception 'BATCH_INVALID: fees exceed the USD received'; end if;
  if v_net <> round(v_net, 2) then
    raise exception 'BATCH_INVALID: USD fees must be whole cents';
  end if;
  v_rate := p_bdt_principal / v_net;

  for v_fee in select * from jsonb_array_elements(coalesce(p_fees, '[]'::jsonb)) loop
    if v_fee->>'currency' = 'USD' then
      v_cap := v_cap + round((v_fee->>'your_share')::numeric * v_rate, 2);
    end if;
  end loop;

  -- Backdating (Assumption 8): nothing dated after this purchase may already
  -- have been drawn from.
  select b.batch_id, b.purchased_at into v_later
  from public.usd_batch_balances b
  where b.status = 'POSTED' and b.used_usd > 0 and b.purchased_at > p_purchased_at
  order by b.purchased_at desc
  limit 1;
  if found then
    raise exception 'BACKDATED_PURCHASE: A purchase dated after this one (%) is already in use. Date it on or after that, or reverse the later usage first', to_char(timezone('Asia/Dhaka', v_later.purchased_at), 'YYYY-MM-DD HH24:MI');
  end if;

  insert into public.usd_purchases (
    source_id, method, usd_amount, bdt_amount, purchased_at, recorded_by, notes,
    gross_usd, net_usd, bdt_principal, fees, capitalized_fees_bdt,
    supplier_rate, effective_rate, rate_warning, external_reference
  ) values (
    p_source_id, nullif(btrim(coalesce(p_method, '')), ''), v_net, p_bdt_principal + v_cap,
    p_purchased_at, p_actor, nullif(btrim(coalesce(p_notes, '')), ''),
    p_gross_usd, v_net, p_bdt_principal, coalesce(p_fees, '[]'::jsonb), v_cap,
    round(v_rate, 6), round((p_bdt_principal + v_cap) / v_net, 6),
    v_rate < 124 or v_rate > 131, v_ref
  )
  returning * into v_row;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'USD_BATCH_POSTED', 'USD_PURCHASE', v_row.id, jsonb_build_object(
    'source_id', p_source_id, 'gross_usd', p_gross_usd, 'net_usd', v_net,
    'bdt_principal', p_bdt_principal, 'capitalized_fees_bdt', v_cap,
    'total_bdt_cost', v_row.bdt_amount, 'fees', v_row.fees));

  return to_jsonb(v_row) || jsonb_build_object('duplicate', false);
end;
$$;

-- USD leaving inventory, drawn oldest batch first (posting_seq, id). A partial
-- take costs round(take × bdt_left ÷ usd_left, 2); the take that empties a
-- batch costs exactly its bdt_left (src/lib/finance/fifo.ts, same rule).
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
  b          record;
begin
  perform public.finance_v2_lock();

  if v_key is not null then
    select * into v_existing from public.usd_outflows where idempotency_key = v_key;
    if found then return to_jsonb(v_existing) || jsonb_build_object('duplicate', true); end if;
  end if;

  if p_kind not in ('META_BILL_PAYMENT', 'OPENING_ADJUSTMENT', 'OTHER') then
    raise exception 'INVALID_KIND: Unknown outflow type';
  end if;
  if p_usd is null or p_usd <= 0 or p_usd <> round(p_usd, 2) then
    raise exception 'INVALID_AMOUNT: Enter a USD amount greater than zero, to the cent';
  end if;
  if p_kind = 'META_BILL_PAYMENT' then
    if p_ad_account_id is null or not exists (
      select 1 from public.ad_accounts where id = p_ad_account_id and is_platform
    ) then
      raise exception 'NOT_FOUND: Choose the platform ad account whose Meta bill was paid';
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
  values (p_kind, p_ad_account_id, p_usd, p_event_at, v_key, nullif(btrim(coalesce(p_notes, '')), ''), p_actor)
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

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'USD_OUTFLOW_POSTED', 'USD_OUTFLOW', v_out.id, jsonb_build_object(
    'kind', p_kind, 'usd', p_usd, 'bdt_cost', v_total, 'ad_account_id', p_ad_account_id));

  return to_jsonb(v_out) || jsonb_build_object('duplicate', false);
end;
$$;

-- Undo an outflow: mirror rows put the exact USD and BDT back into the same
-- batches. The original rows stay.
create or replace function public.reverse_usd_outflow(p_actor uuid, p_outflow_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out public.usd_outflows;
begin
  perform public.finance_v2_lock();
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Give a reason for the reversal';
  end if;
  select * into v_out from public.usd_outflows where id = p_outflow_id for update;
  if not found then raise exception 'NOT_FOUND: Outflow not found'; end if;
  if v_out.status <> 'POSTED' then raise exception 'ALREADY_REVERSED: This outflow is already reversed'; end if;

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

-- Undo a purchase — only while none of its dollars are in use.
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

revoke all on function public.finance_block_mutation() from public, anon, authenticated;
revoke all on function public.finance_v2_lock() from public, anon, authenticated;
grant execute on function public.finance_v2_lock() to service_role;
revoke all on function public.post_usd_purchase(uuid, uuid, numeric, numeric, jsonb, timestamptz, text, text, text) from public, anon, authenticated;
grant execute on function public.post_usd_purchase(uuid, uuid, numeric, numeric, jsonb, timestamptz, text, text, text) to service_role;
revoke all on function public.post_usd_outflow(uuid, text, numeric, timestamptz, uuid, text, text) from public, anon, authenticated;
grant execute on function public.post_usd_outflow(uuid, text, numeric, timestamptz, uuid, text, text) to service_role;
revoke all on function public.reverse_usd_outflow(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_usd_outflow(uuid, uuid, text) to service_role;
revoke all on function public.reverse_usd_purchase(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_usd_purchase(uuid, uuid, text) to service_role;

comment on table public.usd_outflows is
  'USD leaving the platform''s inventory (Meta bill paid, opening cut-over, other). FIFO cost in inventory_allocations.';
comment on table public.inventory_allocations is
  'Which batch each USD outflow drew from, at what BDT cost. Insert-only; reversals are mirror rows.';
comment on table public.platform_finance_audit is
  'Platform finance audit trail. Insert-only. Not audit_logs: org zero is also xRush Agency.';
