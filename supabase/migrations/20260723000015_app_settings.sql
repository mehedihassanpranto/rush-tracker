-- ============================================================================
-- Rush Tracker — app_settings (runtime-configurable settings).
--
-- Env vars can't be live-updated from application code on Vercel — they're
-- baked in per-deployment, only take effect on the next build/cold start.
-- This table is the DB-backed alternative for values an admin should be able
-- to change from a Settings screen with no redeploy: currently the Meta
-- integration's credentials (META_SYSTEM_USER_TOKEN, META_BUSINESS_ID,
-- META_API_VERSION). Env vars remain the fallback default when a key has no
-- row here — see meta.server.ts's getMetaConfig().
--
-- SECURITY: unlike every other table in this app (SELECT-only RLS for
-- `authenticated`), this one gets ZERO policies — this table can hold live
-- secrets (the Meta System User token), so it must only ever be reachable
-- through the service-role server layer, never queried directly from a
-- browser session, not even by an authenticated admin.
-- ============================================================================

create table public.app_settings (
  key        text primary key,
  value      text,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

create trigger trg_app_settings_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

alter table public.app_settings enable row level security;
-- Intentionally no policies: authenticated has zero access via RLS,
-- service_role bypasses RLS entirely (the only intended access path).

-- ----------------------------------------------------------------------------
-- Permission (spec §8 style). Sensitive: SUPER_ADMIN gets it implicitly via
-- has_permission()'s blanket rule; NOT granted to ADMIN by default, same
-- treatment as exchange_rate.manage / users.manage. An ADMIN can still be
-- granted it individually via the existing Users screen.
-- ----------------------------------------------------------------------------
insert into public.permissions (key, description) values
  ('integrations.manage', 'Manage third-party integration credentials (e.g. Meta)');
