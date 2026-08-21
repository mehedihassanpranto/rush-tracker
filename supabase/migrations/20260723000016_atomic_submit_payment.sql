-- ============================================================================
-- Rush Tracker — Atomic payment submission (closes an overpayment-guard race).
--
-- submitPaymentFn previously checked "amount <= due - pending" with two plain
-- SELECTs in application code, then inserted afterward with no lock tying the
-- read to the write. Two concurrent submissions from the same client both saw
-- the same pre-insert snapshot and could each pass the guard independently,
-- letting a client stack multiple full-amount PENDING payments beyond their
-- actual outstanding due. Moving the whole check+insert into one
-- SECURITY DEFINER RPC that locks the client row first closes the race —
-- same pattern already used by approve_payment/approve_limit_request.
-- ============================================================================

create or replace function public.submit_payment(
  p_client_id          uuid,
  p_amount_bdt         numeric,
  p_payment_method     text,
  p_transaction_reference text,
  p_payment_request_id uuid,
  p_actor              uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due       numeric(18, 2);
  v_pending   numeric(18, 2);
  v_outstanding numeric(18, 2);
  v_payment_id uuid;
begin
  if p_amount_bdt is null or p_amount_bdt <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  -- Lock the client row first so a concurrent submit_payment call for the
  -- same client blocks until this transaction commits — the read of
  -- due/pending below can then never race a second insert.
  perform 1 from public.clients where id = p_client_id for update;
  if not found then raise exception 'Client not found'; end if;

  -- client_financials() defines due as debits - credits; mirror that here
  -- rather than depending on it, since we're already inside the lock.
  select coalesce(sum(debit_bdt), 0) - coalesce(sum(credit_bdt), 0)
    into v_due
    from public.ledger_entries
    where client_id = p_client_id;

  select coalesce(sum(amount_bdt), 0)
    into v_pending
    from public.payments
    where client_id = p_client_id and status = 'PENDING';

  v_outstanding := v_due - v_pending;

  if v_outstanding <= 0 then
    raise exception 'OVERPAYMENT: you have no outstanding due to pay right now';
  end if;
  if p_amount_bdt > v_outstanding then
    raise exception 'OVERPAYMENT: amount exceeds your outstanding due of %', v_outstanding;
  end if;

  if p_payment_request_id is not null then
    if not exists (
      select 1 from public.payment_requests
      where id = p_payment_request_id and client_id = p_client_id
    ) then
      raise exception 'Payment request not found';
    end if;
  end if;

  insert into public.payments
    (client_id, payment_request_id, amount_bdt, payment_method,
     transaction_reference, submitted_by, status)
  values
    (p_client_id, p_payment_request_id, p_amount_bdt, p_payment_method,
     p_transaction_reference, p_actor, 'PENDING')
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;

revoke all on function public.submit_payment(uuid, numeric, text, text, uuid, uuid) from public;
grant execute on function public.submit_payment(uuid, numeric, text, text, uuid, uuid) to service_role;
