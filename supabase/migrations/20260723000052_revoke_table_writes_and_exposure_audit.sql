-- Defense in depth + a way to keep it that way.
--
-- 1) anon and authenticated held INSERT/UPDATE/DELETE/TRUNCATE on 30 of 33
--    public tables by default grant. Nothing exploited that — RLS is enabled
--    everywhere and there are no write policies — but it meant a single future
--    policy mistake would have opened a write path. The app never writes
--    through a user session (the user-scoped client only reads; every write goes
--    through the service-role server layer), so the grants are removed.
--    SELECT stays: RLS policies decide what a signed-in user may read.
--
-- 2) client_exposure_report() lets a test assert, against a real database, what
--    anon/authenticated can still reach, instead of trusting migration text
--    (which is exactly what failed for function privileges). service_role only.

revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

create or replace function public.client_exposure_report()
returns table (kind text, name text, role_name text, privilege text)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select 'function'::text, p.proname::text, r.rolname::text, 'execute'::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
   where n.nspname = 'public' and p.prokind = 'f'
     and has_function_privilege(r.rolname, p.oid, 'execute')
  union all
  select 'table'::text, c.relname::text, r.rolname::text, priv.p
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as priv(p)
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
     and has_table_privilege(r.rolname, c.oid, priv.p)
  order by 1, 2, 3, 4;
$$;

revoke execute on function public.client_exposure_report() from public, anon, authenticated;
grant execute on function public.client_exposure_report() to service_role;
