-- ============================================================================
-- Agencies pay the platform (owner decisions, 2026-10-23).
--
-- Until now only a platform admin could record what an agency paid
-- (agency_payments, 000064), and an agency could not see what it owed. Now
-- the agency's SUPER_ADMIN submits a payment with proof; a platform admin
-- approves it (booked through record_agency_payment: settles what is owed,
-- the rest becomes an advance) or rejects it with a reason. Same shape as a
-- client paying an agency (payments / approve_payment).
--
--   agency_payment_submissions  PENDING → APPROVED | REJECTED | CANCELLED.
--                               The proof is an attachments row
--                               (entity_type AGENCY_PAYMENT_SUBMISSION), stored
--                               in the private proofs bucket like every proof.
--   agency_payments.submission_id  which submission an approved payment came
--                               from (NULL for payments the platform recorded).
--   platform_settings 'agency_payment_instructions'  where agencies should
--                               send money; shown on their billing page.
--
-- Deletion: like subscription_payments (000053), submissions go with their
-- agency (ON DELETE CASCADE) and a deleted login only clears submitted_by, so
-- offboarding is never blocked. The booked agency_payments row is the
-- platform's history and survives (000064: organization_id SET NULL).
--
-- Access: RLS on, zero policies, grants revoked; functions service_role only.
-- The server layer scopes every agency read to the caller's own organization.
--
-- MANUAL ROLLBACK:
--   drop function public.submit_agency_payment, public.approve_agency_payment_submission,
--     public.reject_agency_payment_submission, public.cancel_agency_payment_submission;
--   alter table public.agency_payments drop column submission_id;
--   drop table public.agency_payment_submissions; drop sequence public.agency_payment_submission_seq;
-- ============================================================================

create sequence public.agency_payment_submission_seq;

create table public.agency_payment_submissions (
  id                 uuid primary key default gen_random_uuid(),
  reference_id       text not null unique
                       default ('APS-' || lpad(nextval('public.agency_payment_submission_seq')::text, 6, '0')),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  bdt_amount         numeric(18, 2) not null check (bdt_amount > 0),
  method             text not null check (length(btrim(method)) > 0),
  external_reference text,
  paid_at            timestamptz not null,
  note               text,
  idempotency_key    text unique,
  status             text not null default 'PENDING'
                       check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  submitted_by       uuid references auth.users (id) on delete set null,
  submitted_at       timestamptz not null default now(),
  reviewed_by        uuid references auth.users (id) on delete set null,
  reviewed_at        timestamptz,
  rejection_reason   text,
  -- The amount that actually arrived, if the reviewer corrected it.
  approved_bdt       numeric(18, 2) check (approved_bdt is null or approved_bdt > 0),
  agency_payment_id  uuid references public.agency_payments (id),
  created_at         timestamptz not null default now(),
  check ((status = 'APPROVED') = (agency_payment_id is not null)),
  check (status <> 'REJECTED' or rejection_reason is not null)
);
create index idx_agency_payment_submissions_org on public.agency_payment_submissions (organization_id, submitted_at desc);
create index idx_agency_payment_submissions_pending on public.agency_payment_submissions (submitted_at) where status = 'PENDING';

alter table public.agency_payments
  add column submission_id uuid references public.agency_payment_submissions (id) on delete set null;

alter table public.agency_payment_submissions enable row level security;
revoke all on public.agency_payment_submissions from anon, authenticated;
revoke all on sequence public.agency_payment_submission_seq from anon, authenticated;

-- ------------------------------------------------------------------- RPCs ---
create or replace function public.submit_agency_payment(
  p_actor uuid, p_org uuid, p_bdt numeric, p_method text, p_reference text,
  p_paid_at timestamptz, p_note text, p_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.agency_payment_submissions;
  v_row      public.agency_payment_submissions;
  v_key      text := nullif(btrim(coalesce(p_key, '')), '');
begin
  if v_key is not null then
    select * into v_existing from public.agency_payment_submissions where idempotency_key = v_key;
    if found then
      if v_existing.organization_id is distinct from p_org then
        raise exception 'NOT_FOUND: Payment not found';
      end if;
      return to_jsonb(v_existing) || jsonb_build_object('duplicate', true);
    end if;
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'NOT_FOUND: Agency not found';
  end if;
  if p_bdt is null or p_bdt <= 0 or p_bdt <> round(p_bdt, 2) then
    raise exception 'INVALID_AMOUNT: Enter the BDT you paid, to the paisa';
  end if;
  if nullif(btrim(coalesce(p_method, '')), '') is null then
    raise exception 'INVALID_KIND: Say how you paid';
  end if;
  if p_paid_at is null or p_paid_at > now() + interval '1 day' then
    raise exception 'INVALID_DATE: Enter when you paid';
  end if;
  insert into public.agency_payment_submissions (
    organization_id, bdt_amount, method, external_reference, paid_at, note, idempotency_key, submitted_by)
  values (p_org, p_bdt, btrim(p_method), nullif(btrim(coalesce(p_reference, '')), ''), p_paid_at,
          nullif(btrim(coalesce(p_note, '')), ''), v_key, p_actor)
  returning * into v_row;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_PAYMENT_SUBMITTED', 'AGENCY_PAYMENT_SUBMISSION', v_row.id,
          jsonb_build_object('organization_id', p_org, 'bdt', p_bdt, 'method', p_method));
  return to_jsonb(v_row) || jsonb_build_object('duplicate', false);
end;
$$;

-- Approve: book it as an agency payment (settles what is owed first, the rest
-- becomes an advance — record_agency_payment, 000064), dated when the agency
-- paid. p_bdt overrides the amount when what arrived differs.
create or replace function public.approve_agency_payment_submission(p_actor uuid, p_id uuid, p_bdt numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.agency_payment_submissions;
  v_amt numeric;
  v_pay jsonb;
begin
  perform public.finance_v2_lock();
  select * into v_sub from public.agency_payment_submissions where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Payment not found'; end if;
  if v_sub.status <> 'PENDING' then
    raise exception 'NOT_PENDING: This payment is already %', lower(v_sub.status);
  end if;
  v_amt := coalesce(p_bdt, v_sub.bdt_amount);
  if v_amt <= 0 or v_amt <> round(v_amt, 2) then
    raise exception 'INVALID_AMOUNT: Enter the BDT that arrived, to the paisa';
  end if;

  v_pay := public.record_agency_payment(
    p_actor, v_sub.organization_id, v_amt, v_sub.paid_at, v_sub.method,
    v_sub.organization_id = '00000000-0000-0000-0000-000000000001'::uuid,
    coalesce(v_sub.external_reference, v_sub.reference_id),
    v_sub.reference_id || coalesce(': ' || v_sub.note, ''),
    'aps-' || v_sub.id::text);

  update public.agency_payments set submission_id = v_sub.id where id = (v_pay->>'id')::uuid;
  update public.agency_payment_submissions
  set status = 'APPROVED', reviewed_by = p_actor, reviewed_at = now(),
      approved_bdt = case when v_amt <> v_sub.bdt_amount then v_amt end,
      agency_payment_id = (v_pay->>'id')::uuid
  where id = p_id
  returning * into v_sub;

  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_PAYMENT_APPROVED', 'AGENCY_PAYMENT_SUBMISSION', p_id,
          jsonb_build_object('bdt', v_amt, 'agency_payment_id', v_pay->>'id'));
  return to_jsonb(v_sub) || jsonb_build_object(
    'applied_bdt', v_pay->'applied_bdt', 'advance_bdt', v_pay->'advance_bdt',
    'payment_reference', v_pay->>'reference_id');
end;
$$;

create or replace function public.reject_agency_payment_submission(p_actor uuid, p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.agency_payment_submissions;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: Tell the agency why';
  end if;
  update public.agency_payment_submissions
  set status = 'REJECTED', reviewed_by = p_actor, reviewed_at = now(), rejection_reason = btrim(p_reason)
  where id = p_id and status = 'PENDING'
  returning * into v_sub;
  if not found then raise exception 'NOT_PENDING: This payment is no longer waiting for review'; end if;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_PAYMENT_REJECTED', 'AGENCY_PAYMENT_SUBMISSION', p_id, jsonb_build_object('reason', btrim(p_reason)));
  return to_jsonb(v_sub);
end;
$$;

-- The agency withdraws its own submission while it is still pending.
create or replace function public.cancel_agency_payment_submission(p_actor uuid, p_org uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.agency_payment_submissions;
begin
  update public.agency_payment_submissions
  set status = 'CANCELLED', reviewed_by = p_actor, reviewed_at = now()
  where id = p_id and organization_id = p_org and status = 'PENDING'
  returning * into v_sub;
  if not found then raise exception 'NOT_PENDING: This payment is no longer waiting for review'; end if;
  insert into public.platform_finance_audit (actor_id, action, entity_type, entity_id, new_values)
  values (p_actor, 'AGENCY_PAYMENT_CANCELLED', 'AGENCY_PAYMENT_SUBMISSION', p_id, '{}'::jsonb);
  return to_jsonb(v_sub);
end;
$$;

revoke all on function public.submit_agency_payment(uuid, uuid, numeric, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.submit_agency_payment(uuid, uuid, numeric, text, text, timestamptz, text, text) to service_role;
revoke all on function public.approve_agency_payment_submission(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.approve_agency_payment_submission(uuid, uuid, numeric) to service_role;
revoke all on function public.reject_agency_payment_submission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reject_agency_payment_submission(uuid, uuid, text) to service_role;
revoke all on function public.cancel_agency_payment_submission(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_agency_payment_submission(uuid, uuid, uuid) to service_role;

comment on table public.agency_payment_submissions is
  'An agency''s payment to the platform, submitted with proof by its SUPER_ADMIN; approved into agency_payments by a platform admin.';
