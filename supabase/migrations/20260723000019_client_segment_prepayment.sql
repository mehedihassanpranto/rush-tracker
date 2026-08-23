-- ============================================================================
-- Rush Tracker — client segmentation (prepaid / postpaid) for limit requests.
--
-- Every client is now either:
--   - prepaid: must pay (fully or partially, admin's call at signup) up front
--     with proof when submitting a limit request. Whatever isn't covered
--     becomes real due, same as any other partial payment.
--   - postpaid: unchanged from the app's original behavior — request now,
--     the full amount becomes due, settle later via the existing
--     Pay Due / admin-verify flow. No payment or proof at request time.
--
-- This supersedes an earlier same-day, never-deployed design (the original
-- 20260723000019) that forced EVERY client to pay 100% up front — nothing
-- from that design was committed or applied anywhere, so it's replaced
-- outright here rather than layered on top of.
-- ============================================================================

create type public.client_segment as enum ('prepaid', 'postpaid');

-- Backfill existing clients as 'postpaid' — matches their actual behavior to
-- date (request now, settle due later). No default going forward: the
-- create-client form must always supply one explicitly.
alter table public.clients add column segment public.client_segment;
update public.clients set segment = 'postpaid' where segment is null;
alter table public.clients alter column segment set not null;

-- ----------------------------------------------------------------------------
-- limit_requests: submission-time payment snapshot.
--
-- total_cost_bdt is the frozen requested_amount_usd * rate at SUBMISSION time
-- — distinct from the existing bdt_charge, which is computed at APPROVAL from
-- the admin-editable approved_amount/approved_rate (spec §28, unchanged).
-- The two can differ if an admin edits the amount/rate at approval; that's a
-- known, accepted reconciliation gap (see CLAUDE.md), not a bug.
--
-- amount_paid_bdt / due_balance_bdt / segment are nullable because they don't
-- apply to requests made before this feature existed — never retroactively
-- rewritten for historical rows, just backfilled to a consistent snapshot
-- (segment = 'postpaid', due_balance = the historical bdt_charge where
-- known) so old rows don't show blank/misleading figures.
-- ----------------------------------------------------------------------------
alter table public.limit_requests add column segment public.client_segment;
alter table public.limit_requests add column total_cost_bdt numeric(18, 2);
alter table public.limit_requests add column amount_paid_bdt numeric(18, 2);
alter table public.limit_requests add column due_balance_bdt numeric(18, 2);

update public.limit_requests
set segment = 'postpaid',
    total_cost_bdt = round(requested_amount_usd * default_usd_rate, 2),
    amount_paid_bdt = 0,
    due_balance_bdt = round(requested_amount_usd * default_usd_rate, 2)
where segment is null;

alter table public.limit_requests alter column segment set not null;
alter table public.limit_requests alter column total_cost_bdt set not null;

comment on column public.limit_requests.segment is
  'The requesting client''s segment AT REQUEST TIME (snapshotted, not a live join to clients.segment) — a client''s segment can change later without rewriting past requests.';
comment on column public.limit_requests.total_cost_bdt is
  'requested_amount_usd * default_usd_rate, frozen at submission. Distinct from bdt_charge (computed at approval from the possibly-admin-edited approved amount/rate).';
comment on column public.limit_requests.amount_paid_bdt is
  'What the client paid up front at submission (prepaid only; 0 for postpaid). Not editable after submission.';
comment on column public.limit_requests.due_balance_bdt is
  'total_cost_bdt - amount_paid_bdt, computed server-side at submission. Informational snapshot only — the client''s actual running due is always the ledger (client_financials()), never this column.';

-- ----------------------------------------------------------------------------
-- Atomic limit approval — now segment-aware. Prepaid requests also record a
-- matching APPROVED payment + PAYMENT ledger credit for amount_paid_bdt
-- (which may be a PARTIAL amount, unlike the superseded design) in the same
-- transaction as the existing LIMIT_APPROVAL debit. Postpaid requests are
-- unchanged from the original behavior: only the debit, no auto-payment —
-- the client settles the resulting due later via the normal Pay Due flow.
-- ----------------------------------------------------------------------------
drop function if exists public.approve_limit_request(uuid, numeric, numeric, uuid, text);

create function public.approve_limit_request(
  p_request_id      uuid,
  p_approved_amount numeric,
  p_approved_rate   numeric,
  p_actor           uuid,
  p_admin_note      text default null
)
returns jsonb
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
  v_payment_id uuid;
  v_payment_ledger_id uuid;
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

  -- Prepaid only: the client already paid amount_paid_bdt up front (proof
  -- attached at submission) — record it as an APPROVED payment + matching
  -- PAYMENT ledger credit. Postpaid requests never reach here with a
  -- positive amount_paid_bdt, so this naturally no-ops for them.
  if v_req.segment = 'prepaid' and coalesce(v_req.amount_paid_bdt, 0) > 0 then
    insert into public.payments
      (client_id, amount_bdt, payment_method, transaction_reference, status,
       submitted_by, reviewed_by, reviewed_at)
    values
      (v_req.client_id, v_req.amount_paid_bdt, 'Limit Request Prepayment',
       v_req.request_number, 'APPROVED', v_req.requested_by, p_actor, now())
    returning id into v_payment_id;

    insert into public.ledger_entries
      (client_id, type, reference_type, reference_id, bdt_amount, debit_bdt, credit_bdt, description, created_by)
    values
      (v_req.client_id, 'PAYMENT', 'PAYMENT', v_payment_id::text,
       v_req.amount_paid_bdt, 0, v_req.amount_paid_bdt,
       'Prepayment for ' || v_req.request_number, p_actor)
    returning id into v_payment_ledger_id;

    insert into public.audit_logs
      (actor_user_id, action, entity_type, entity_id, new_values)
    values
      (p_actor, 'PAYMENT_APPROVED', 'PAYMENT', v_payment_id::text,
       jsonb_build_object(
         'amount_bdt', v_req.amount_paid_bdt,
         'ledger_id', v_payment_ledger_id,
         'source', 'LIMIT_REQUEST_AUTO_PAYMENT',
         'limit_request_id', p_request_id
       ));
  end if;

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
       'ledger_id', v_ledger_id,
       'payment_id', v_payment_id
     ));

  return jsonb_build_object(
    'ledger_id', v_ledger_id,
    'payment_id', v_payment_id,
    'payment_ledger_id', v_payment_ledger_id
  );
end;
$$;

revoke all on function public.approve_limit_request(uuid, numeric, numeric, uuid, text) from public;
grant execute on function public.approve_limit_request(uuid, numeric, numeric, uuid, text) to service_role;
