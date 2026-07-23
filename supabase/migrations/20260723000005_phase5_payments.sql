-- ============================================================================
-- Rush Tracker — Phase 5: Payments & Payment Requests.
--
-- Only an APPROVED payment writes a ledger credit (spec §43, §45). Pending
-- payments never change due (Rule 14). A payment request by itself changes
-- nothing (spec §48) — it just asks the client to pay.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums + sequences
-- ----------------------------------------------------------------------------
create type public.payment_status as enum (
'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'
);
create type public.payment_request_status as enum (
'REQUESTED', 'PAYMENT_SUBMITTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'
);

create sequence if not exists public.payment_seq;
create sequence if not exists public.payment_request_seq;

-- ----------------------------------------------------------------------------
-- Payment requests (spec §47) — admin asks a client to pay.
-- ----------------------------------------------------------------------------
create table public.payment_requests (
id                   uuid primary key default gen_random_uuid(),
request_number       text not null unique
                      default ('PR-' || lpad(nextval('public.payment_request_seq')::text, 6, '0')),
client_id            uuid not null references public.clients (id),
requested_amount_bdt numeric(18, 2) not null check (requested_amount_bdt > 0),
status               public.payment_request_status not null default 'REQUESTED',
message              text,
due_date             date,
created_by           uuid references auth.users (id),
created_at           timestamptz not null default now(),
updated_at           timestamptz not null default now()
);

create index idx_payment_requests_client on public.payment_requests (client_id);
create index idx_payment_requests_status on public.payment_requests (status);

create trigger trg_payment_requests_updated_at
before update on public.payment_requests
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Payments (spec §43)
-- ----------------------------------------------------------------------------
create table public.payments (
id                    uuid primary key default gen_random_uuid(),
payment_number        text not null unique
                      default ('PAY-' || lpad(nextval('public.payment_seq')::text, 6, '0')),
client_id             uuid not null references public.clients (id),
payment_request_id    uuid references public.payment_requests (id),
amount_bdt            numeric(18, 2) not null check (amount_bdt > 0),
payment_method        text,
transaction_reference text,
status                public.payment_status not null default 'PENDING',
submitted_by          uuid references auth.users (id),
submitted_at          timestamptz not null default now(),
reviewed_by           uuid references auth.users (id),
reviewed_at           timestamptz,
admin_note            text,
rejection_reason      text,
created_at            timestamptz not null default now(),
updated_at            timestamptz not null default now()
);

create index idx_payments_client on public.payments (client_id);
create index idx_payments_status on public.payments (status);
create index idx_payments_request on public.payments (payment_request_id);
create index idx_payments_created on public.payments (created_at desc);

create trigger trg_payments_updated_at
before update on public.payments
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Atomic payment approval (spec §45). Only here is the ledger credit created.
-- SECURITY DEFINER + row lock; execute granted to service_role only.
-- ----------------------------------------------------------------------------
create or replace function public.approve_payment(
p_payment_id uuid,
p_actor      uuid
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
begin
select * into v_pay from public.payments where id = p_payment_id for update;
if not found then raise exception 'Payment not found'; end if;
if v_pay.status <> 'PENDING' then
raise exception 'Payment is not pending (current status: %)', v_pay.status;
end if;

update public.payments
set status = 'APPROVED', reviewed_by = p_actor, reviewed_at = now()
where id = p_payment_id;

insert into public.ledger_entries
(client_id, type, reference_type, reference_id, bdt_amount, debit_bdt, credit_bdt, description, created_by)
values
(v_pay.client_id, 'PAYMENT', 'PAYMENT', p_payment_id::text,
  v_pay.amount_bdt, 0, v_pay.amount_bdt, 'Payment ' || v_pay.payment_number, p_actor)
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
(actor_user_id, action, entity_type, entity_id, new_values)
values
(p_actor, 'PAYMENT_APPROVED', 'PAYMENT', p_payment_id::text,
  jsonb_build_object('amount_bdt', v_pay.amount_bdt, 'ledger_id', v_ledger_id));

return v_ledger_id;
end;
$$;

revoke all on function public.approve_payment(uuid, uuid) from public;
grant execute on function public.approve_payment(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Row Level Security (SELECT-only for browser; writes via server)
-- ----------------------------------------------------------------------------
alter table public.payments enable row level security;
alter table public.payment_requests enable row level security;

create policy payments_select on public.payments
for select to authenticated
using (public.is_admin() or public.is_client_member(client_id));

create policy payment_requests_select on public.payment_requests
for select to authenticated
using (public.is_admin() or public.is_client_member(client_id));
