-- ============================================================================
-- Rush Tracker — reset_all_data() now also clears employees.
--
-- Gap found in practice: employees (added in migration …0012, after this
-- function was first written in …0008) has no FK to any table the original
-- TRUNCATE ... CASCADE touched, so a reset left employee rows behind while
-- client_employees (FK'd to clients) correctly cascaded away — orphaning
-- every employee's client links without removing the employees themselves.
-- Adds employees to the truncated set and resets its code sequence too.
-- ============================================================================

create or replace function public.reset_all_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1) Empty all business/transactional tables. exchange_rates is preserved so
  --    the configured USD rate (needed for billing + USD display) survives.
  truncate table
    public.notifications,
    public.audit_logs,
    public.adjustments,
    public.payments,
    public.payment_requests,
    public.ledger_entries,
    public.limit_requests,
    public.attachments,
    public.ad_account_assignments,
    public.ad_accounts,
    public.client_employees,
    public.employees,
    public.client_memberships,
    public.clients
  restart identity cascade;

  -- 2) Delete every CLIENT login (cascades their profile + memberships).
  delete from auth.users
  where id in (
    select p.user_id
    from public.user_profiles p
    join public.roles r on r.id = p.role_id
    where r.key = 'CLIENT'
  );

  -- 3) Restart the document-number counters so codes begin at 0001 again.
  perform setval('public.client_code_seq', 1, false);
  perform setval('public.ad_account_code_seq', 1, false);
  perform setval('public.limit_request_seq', 1, false);
  perform setval('public.ledger_txn_seq', 1, false);
  perform setval('public.payment_seq', 1, false);
  perform setval('public.payment_request_seq', 1, false);
  perform setval('public.adjustment_seq', 1, false);
  perform setval('public.employee_code_seq', 1, false);
end;
$$;

revoke all on function public.reset_all_data() from public;
grant execute on function public.reset_all_data() to service_role;
