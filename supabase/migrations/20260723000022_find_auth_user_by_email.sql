-- ============================================================================
-- Rush Tracker — lookup helper so "Add login" (admin) and "Add teammate"
-- (client self-service) can detect an email that already has an auth.users
-- row and REUSE it instead of calling admin.auth.admin.createUser() again,
-- which fails with "A user with this email address has already been
-- registered". client_memberships already supports this at the schema
-- level (unique(user_id, client_id), not user_id alone — see
-- 20260723000001_phase1_foundation.sql) — one auth user can legitimately be
-- a login for more than one client. Only the creation path never checked
-- for an existing user before this.
--
-- SECURITY DEFINER because auth.users isn't reachable via the anon/
-- authenticated PostgREST roles; granted to service_role only, same as
-- every other privileged RPC in this app (assign/release/transfer,
-- approve_limit_request, etc.).
-- ============================================================================

create or replace function public.find_auth_user_by_email(p_email text)
returns table (user_id uuid, role_key text)
language sql
security definer
set search_path = public, auth
stable
as $$
  select u.id, r.key
  from auth.users u
  left join public.user_profiles p on p.user_id = u.id
  left join public.roles r on r.id = p.role_id
  where lower(u.email) = lower(p_email)
  limit 1
$$;

revoke all on function public.find_auth_user_by_email(text) from public;
grant execute on function public.find_auth_user_by_email(text) to service_role;
