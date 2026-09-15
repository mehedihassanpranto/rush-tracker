-- ============================================================================
-- Limit requests on platform-assigned accounts route through the platform for
-- approval, instead of the agency approving directly.
--
-- Requested as §4.3 of the "Mother Platform Account Control" spec, confirmed
-- explicitly via AskUserQuestion before building (a previous "sure" was
-- treated as ambiguous, not a go-ahead — this is a real behavioral change to
-- how every one of xRush's 34 live accounts' limit requests gets approved,
-- since 100% of them are currently platform-assigned).
--
-- WHICH ACCOUNTS THIS APPLIES TO IS GATED THE SAME WAY canMutateSpendCap()
-- ALREADY GATES DIRECT EDITS — ad_accounts.is_platform, not a copy of that
-- flag on limit_requests. The server layer (limit-request.fns.ts /
-- server/platform/limit-requests.fns.ts) enforces:
--   - the agency's own approveLimitRequestFn refuses outright when the
--     account is_platform = true — it can reject directly, or send to
--     platform, but never approve a platform-assigned account's request
--     itself.
--   - the platform's approvePlatformLimitRequestFn requires BOTH
--     status = 'PENDING_PLATFORM_REVIEW' AND is_platform = true.
-- These two RPCs only need to accept the new status as an alternative to
-- 'PENDING' — they do not need to know about is_platform at all, since the
-- TS layer above never calls them for the wrong combination.
-- ============================================================================

alter table public.limit_requests
  add column sent_to_platform_at timestamptz,
  add column sent_to_platform_by uuid references auth.users (id);

-- Widen the one-pending-per-account guard: a request awaiting platform
-- review is still "in flight" and must still block a second submission on
-- the same account, exactly like a plain PENDING request does today.
drop index if exists uniq_pending_request_per_account;
create unique index uniq_pending_request_per_account
  on public.limit_requests (ad_account_id)
  where status in ('PENDING', 'PENDING_PLATFORM_REVIEW');

-- ----------------------------------------------------------------------------
-- approve_limit_request — accept PENDING_PLATFORM_REVIEW as an alternative
-- starting status. Everything else (stale-baseline check, ledger debit,
-- prepaid/partial auto-payment, audit) is unchanged — a platform admin's
-- approval of an escalated request goes through the exact same money path an
-- agency's own approval always has, just with p_organization_id resolved
-- from the request's own client/agency rather than the caller's own org
-- (the caller is a platform admin, who has no agency of their own).
-- ----------------------------------------------------------------------------
create or replace function public.approve_limit_request(
  p_request_id      uuid,
  p_approved_amount numeric,
  p_approved_rate   numeric,
  p_actor           uuid,
  p_organization_id uuid,
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
  if v_req.organization_id <> p_organization_id then
    raise exception 'Limit request not found';
  end if;
  if v_req.status not in ('PENDING', 'PENDING_PLATFORM_REVIEW') then
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
     usd_amount, usd_rate, bdt_amount, debit_bdt, credit_bdt, description, created_by, organization_id)
  values
    (v_req.client_id, 'LIMIT_APPROVAL', 'LIMIT_REQUEST', p_request_id::text,
     p_approved_amount, p_approved_rate, v_charge, v_charge, 0,
     'Limit approval ' || v_req.request_number, p_actor, v_req.organization_id)
  returning id into v_ledger_id;

  -- Prepaid AND partial: the client already paid amount_paid_bdt up front
  -- (proof attached at submission) — record it as an APPROVED payment +
  -- matching PAYMENT ledger credit. Postpaid requests never have a positive
  -- amount_paid_bdt, so this naturally no-ops for them.
  if v_req.segment <> 'postpaid' and coalesce(v_req.amount_paid_bdt, 0) > 0 then
    insert into public.payments
      (client_id, amount_bdt, payment_method, transaction_reference, status,
       submitted_by, reviewed_by, reviewed_at, organization_id)
    values
      (v_req.client_id, v_req.amount_paid_bdt, 'Limit Request Prepayment',
       v_req.request_number, 'APPROVED', v_req.requested_by, p_actor, now(), v_req.organization_id)
    returning id into v_payment_id;

    insert into public.ledger_entries
      (client_id, type, reference_type, reference_id, bdt_amount, debit_bdt, credit_bdt, description, created_by, organization_id)
    values
      (v_req.client_id, 'PAYMENT', 'PAYMENT', v_payment_id::text,
       v_req.amount_paid_bdt, 0, v_req.amount_paid_bdt,
       'Prepayment for ' || v_req.request_number, p_actor, v_req.organization_id)
    returning id into v_payment_ledger_id;

    insert into public.audit_logs
      (actor_user_id, action, entity_type, entity_id, new_values, organization_id)
    values
      (p_actor, 'PAYMENT_APPROVED', 'PAYMENT', v_payment_id::text,
       jsonb_build_object(
         'amount_bdt', v_req.amount_paid_bdt,
         'ledger_id', v_payment_ledger_id,
         'source', 'LIMIT_REQUEST_AUTO_PAYMENT',
         'limit_request_id', p_request_id
       ), v_req.organization_id);
  end if;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
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
     ), v_req.organization_id);

  return jsonb_build_object(
    'ledger_id', v_ledger_id,
    'payment_id', v_payment_id,
    'payment_ledger_id', v_payment_ledger_id
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- rebase_limit_request — same widening, so a stale platform-assigned request
-- can still be rebased from the platform's own review screen exactly like
-- the agency's own approval screen already does.
-- ----------------------------------------------------------------------------
create or replace function public.rebase_limit_request(
  p_request_id      uuid,
  p_actor           uuid,
  p_organization_id uuid
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
  if v_req.organization_id <> p_organization_id then
    raise exception 'Limit request not found';
  end if;
  if v_req.status not in ('PENDING', 'PENDING_PLATFORM_REVIEW') then
    raise exception 'Request is not pending';
  end if;

  select * into v_account from public.ad_accounts where id = v_req.ad_account_id for update;
  if not found then raise exception 'Ad account not found'; end if;

  v_new_expected := v_account.current_limit_usd + v_req.requested_amount_usd;

  update public.limit_requests
    set opening_balance_usd    = v_account.current_limit_usd,
        expected_new_limit_usd = v_new_expected
    where id = p_request_id;

  insert into public.audit_logs
    (actor_user_id, action, entity_type, entity_id, old_values, new_values, organization_id)
  values
    (p_actor, 'LIMIT_REQUEST_REBASED', 'LIMIT_REQUEST', p_request_id::text,
     jsonb_build_object('opening_balance_usd', v_req.opening_balance_usd),
     jsonb_build_object(
       'opening_balance_usd', v_account.current_limit_usd,
       'expected_new_limit_usd', v_new_expected
     ), v_req.organization_id);
end;
$$;
