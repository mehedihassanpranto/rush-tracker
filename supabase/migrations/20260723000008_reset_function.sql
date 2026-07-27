-- ============================================================================
-- Rush Tracker — reset_all_data()
--
-- Backs the Settings → Danger Zone "Clear all data" button. Wipes ALL
-- business/transactional data and every CLIENT login, keeps admin/super-admin
-- logins + roles + permissions, and restarts the document-number counters.
--
-- SECURITY: SECURITY DEFINER, execute granted to service_role ONLY. The server
-- function that calls it additionally requires the caller to be SUPER_ADMIN and
-- to submit an exact confirmation phrase. The proof FILES in storage are
-- emptied by the server function via the Storage API (SQL cannot delete them).
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
end;
$$;

revoke all on function public.reset_all_data() from public;
grant execute on function public.reset_all_data() to service_role;
