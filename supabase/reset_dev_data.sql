-- ============================================================================
-- Rush Tracker — DEV/TEST DATA RESET
--
--   ⚠️  DESTRUCTIVE AND IRREVERSIBLE. Run ONLY on a project whose data you are
--       willing to lose. This wipes ALL business/transactional data and ALL
--       client logins so you can re-test from a clean slate.
--
--   KEEPS:   admin & super-admin logins, roles, permissions, role/user
--            permission grants (so you stay signed in and configured).
--   CLEARS:  clients, ad accounts + assignments, limit requests, ledger,
--            payments, payment requests, adjustments, exchange rates,
--            notifications, audit logs, proof metadata + files; and deletes
--            every CLIENT login.
--   RESETS:  the human-readable code counters (CL-, ADA-, LR-, TXN-, PAY-,
--            PR-, ADJ-) back to 1.
--
-- Run the whole script at once in the Supabase SQL editor. After it finishes,
-- set a default USD rate again in the app (Settings → Exchange Rate) before
-- approving any limit requests.
-- ============================================================================

begin;

-- 1) Empty all business/transactional tables (child→parent via CASCADE).
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
  public.clients,
  public.exchange_rates
restart identity cascade;

-- 2) Delete every CLIENT login (cascades their profile + any memberships).
--    Admin / super-admin logins are left untouched.
delete from auth.users
where id in (
  select p.user_id
  from public.user_profiles p
  join public.roles r on r.id = p.role_id
  where r.key = 'CLIENT'
);

-- 3) Restart the document-number counters so codes begin at 0001 again.
alter sequence public.client_code_seq       restart with 1;
alter sequence public.ad_account_code_seq   restart with 1;
alter sequence public.limit_request_seq     restart with 1;
alter sequence public.ledger_txn_seq        restart with 1;
alter sequence public.payment_seq           restart with 1;
alter sequence public.payment_request_seq   restart with 1;
alter sequence public.adjustment_seq        restart with 1;

-- 4) Remove uploaded proof files from the private `proofs` storage bucket.
delete from storage.objects where bucket_id = 'proofs';

commit;

-- Sanity check (should all be 0):
-- select
--   (select count(*) from public.clients)        as clients,
--   (select count(*) from public.ad_accounts)    as ad_accounts,
--   (select count(*) from public.ledger_entries) as ledger,
--   (select count(*) from public.payments)       as payments,
--   (select count(*) from public.audit_logs)     as audit_logs;
