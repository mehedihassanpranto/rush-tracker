-- ============================================================================
-- SECURITY FIX — privileged functions were callable by anyone with the public
-- anon key.
--
-- Every earlier migration meant its RPCs to be service_role-only and wrote
-- `revoke all ... from public; grant execute ... to service_role`. That never
-- worked here: Supabase's default privileges grant EXECUTE on every new
-- function in `public` to `anon` and `authenticated` DIRECTLY, and revoking
-- from PUBLIC does not remove a role's own grant. Verified on the live
-- database: an unauthenticated request with only the public anon key (which
-- ships in the browser bundle) could execute reset_all_data(org),
-- approve_payment, approve_limit_request, assign/release/transfer_ad_account,
-- create_adjustment, reverse_financial_transaction, submit_payment,
-- find_auth_user_by_email (email -> user id enumeration) and the dashboard
-- aggregates. reset_all_data(p_organization_id) deletes a whole agency's
-- business data, and org zero's id is the fixed, well-known
-- 00000000-0000-0000-0000-000000000001.
--
-- Fix: every function in `public` becomes service_role-only EXCEPT the six
-- helpers RLS policies call (a policy expression runs as the querying role, so
-- it needs EXECUTE). Those are read-only and return nothing sensitive: they
-- describe the caller's own identity or a boolean.
--
-- The app is unaffected: every `.rpc(` call goes through the service-role
-- admin client (checked for each call site before writing this).
-- ============================================================================

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname <> all (array[
        'current_org_id', 'has_permission', 'is_admin',
        'is_client_member', 'is_org_active', 'is_platform_admin'
      ])
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$$;

-- The same default grant would re-expose every FUTURE function, so remove it at
-- the source. A new function a policy needs must now be granted explicitly.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres revoke execute on functions from anon, authenticated;
