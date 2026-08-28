-- ============================================================================
-- Rush Tracker — Let an admin correct a payment's amount before approving it.
--
-- Requested for postpaid/partial clients specifically (the UI gates on
-- segment; this RPC itself doesn't need to — it's called only from the
-- approval screen either way). approve_payment is already this app's
-- designated admin-override point (unlike the client-side submission race
-- fix, admin approval stays override-capable by design — see the atomic
-- submit_payment migration's notes), so this extends it in place rather than
-- adding a separate pre-approval edit endpoint: one atomic RPC call locks the
-- row, optionally corrects amount_bdt, then credits the ledger with the
-- final figure — never two separate writes that could race or leave the
-- payments row and the ledger credit disagreeing on the amount.
-- ============================================================================

drop function if exists public.approve_payment(uuid, uuid);

create or replace function public.approve_payment(
  p_payment_id uuid,
  p_actor      uuid,
  p_amount_bdt numeric default null
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
v_final_amount numeric(18, 2);
begin
select * into v_pay from public.payments where id = p_payment_id for update;
if not found then raise exception 'Payment not found'; end if;
if v_pay.status <> 'PENDING' then
raise exception 'Payment is not pending (current status: %)', v_pay.status;
end if;

if p_amount_bdt is not null and p_amount_bdt <= 0 then
  raise exception 'Amount must be greater than zero';
end if;

v_final_amount := coalesce(p_amount_bdt, v_pay.amount_bdt);

if p_amount_bdt is not null and p_amount_bdt <> v_pay.amount_bdt then
  update public.payments set amount_bdt = p_amount_bdt where id = p_payment_id;
end if;

update public.payments
set status = 'APPROVED', reviewed_by = p_actor, reviewed_at = now()
where id = p_payment_id;

insert into public.ledger_entries
(client_id, type, reference_type, reference_id, bdt_amount, debit_bdt, credit_bdt, description, created_by)
values
(v_pay.client_id, 'PAYMENT', 'PAYMENT', p_payment_id::text,
  v_final_amount, 0, v_final_amount, 'Payment ' || v_pay.payment_number, p_actor)
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
(actor_user_id, action, entity_type, entity_id, old_values, new_values)
values
(p_actor, 'PAYMENT_APPROVED', 'PAYMENT', p_payment_id::text,
  case when p_amount_bdt is not null and p_amount_bdt <> v_pay.amount_bdt
    then jsonb_build_object('amount_bdt', v_pay.amount_bdt) else null end,
  jsonb_build_object('amount_bdt', v_final_amount, 'ledger_id', v_ledger_id));

return v_ledger_id;
end;
$$;

revoke all on function public.approve_payment(uuid, uuid, numeric) from public;
grant execute on function public.approve_payment(uuid, uuid, numeric) to service_role;
