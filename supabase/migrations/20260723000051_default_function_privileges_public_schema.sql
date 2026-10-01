-- Completes 20260723000050. That migration revoked the GLOBAL default function
-- privileges, but Supabase also keeps a separate default-privilege entry scoped
-- to the `public` schema which still granted EXECUTE to anon and authenticated:
-- a function created after 000050 was exposed again (confirmed by creating a
-- throwaway function and reading its ACL). Remove that entry's grants too, so a
-- new function is service_role-only unless a migration grants more on purpose.
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
