-- ============================================================================
-- Rush Tracker — fix: a suspended organization's users could not read their
-- own user_profiles row, which broke the entire subscription-gate UX.
--
-- Bug (found by live testing Phase 3's gate against a throwaway suspended
-- organization, not by reading the code): 20260723000031's
-- user_profiles_select policy gates EVERY row — including the caller's own —
-- on is_org_active(organization_id). But auth.fns.ts's loadSessionUser()
-- reads exactly that row, through the RLS-scoped client, to build
-- SessionUser at all. So for a suspended organization:
--
--   own profile row invisible -> loadSessionUser() returns null
--     -> context.user is null -> the admin/portal route guards treat it as
--     "not signed in" and redirect to /login (not /subscription-suspended)
--     -> /subscription-suspended itself also redirects to /login, since it
--        requires a session too
--     -> logging back in fails with "This account is inactive or not fully
--        provisioned", because loginFn calls the same loadSessionUser().
--
-- Net effect: a suspended organization's users were indistinguishable from
-- logged-out ones and could never see the "your subscription is inactive"
-- page at all. Verified before and after this migration against a real
-- suspended organization.
--
-- Fix: the caller's OWN row is always readable, regardless of subscription
-- status — it is that user's own identity row, so no tenant isolation is
-- lost. Reading OTHER users' rows (the admin Users screen) still requires
-- both an organization match AND an active subscription, exactly as before.
--
-- The subscription gate itself is unaffected: it is enforced in
-- guards.server.ts (every server fn) and in the admin/portal route guards,
-- never by hiding the user's own identity from them.
-- ============================================================================

alter policy user_profiles_select on public.user_profiles
  using (
    -- Own row: always readable (session bootstrap depends on it).
    user_id = (select auth.uid())
    -- Other rows: organization-scoped and subscription-gated as before.
    or (
      public.is_admin()
      and organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );
