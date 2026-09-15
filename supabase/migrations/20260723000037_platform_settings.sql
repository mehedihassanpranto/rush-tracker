-- ============================================================================
-- Rush Tracker — the PLATFORM's own settings, separate from any agency's.
--
-- Until now the Meta System User token and Business Portfolio ID were modelled
-- as org zero's (xRush Agency's) credentials: `app_settings` is keyed by
-- (organization_id, key), and getMetaConfig() fell back to the META_* env vars
-- for org zero alone. That was always a half-truth. Every one of the 34 ad
-- accounts those credentials govern is a PLATFORM-POOL account
-- (is_platform = true, organization_id null — migration 000035), so the
-- portfolio they point at belongs to Rush Tracker the platform, not to xRush
-- the agency that happens to hold the grants.
--
-- This table is that separation made real. The platform is NOT an
-- organization: it has no subscription, no clients, no ledger, and it must
-- not appear in the organizations list. Storing its credentials in
-- `app_settings` would have required inventing a fake organization row for it
-- (the organization_id column is NOT NULL and FK-constrained) — exactly the
-- conflation being undone here. A separate table makes the two scopes
-- physically incapable of colliding: there is no organization_id to get wrong,
-- and no query can return an agency's token where the platform's was meant.
--
-- The META_* env vars are now the PLATFORM's credentials (they always pointed
-- at the pool's portfolio), read as the fallback when a key has no row here —
-- same live-update-without-redeploy rationale as app_settings itself.
-- After this, an agency has a Meta integration only if it connected its own
-- Business Portfolio; org zero gets no special treatment any more.
--
-- SECURITY: RLS enabled with ZERO policies, identical to app_settings. This
-- table holds a live secret (the platform's System User token, which can write
-- spend caps on every pool account) and must only ever be reachable through
-- the service-role server layer behind requirePlatformAdmin().
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   drop table public.platform_settings;
-- ============================================================================

create table public.platform_settings (
  key        text primary key,
  value      text,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

create trigger trg_platform_settings_updated_at
  before update on public.platform_settings
  for each row execute function public.set_updated_at();

alter table public.platform_settings enable row level security;
-- Intentionally no policies: `authenticated` has zero access via RLS,
-- service_role bypasses RLS entirely (the only intended access path).

comment on table public.platform_settings is
  'Rush Tracker platform''s own runtime settings — currently the Meta '
  'credentials for the platform-owned ad account pool. Deliberately NOT '
  'keyed by organization: the platform is not an agency. The META_* env '
  'vars are the fallback. See getMetaConfig() in src/server/meta/meta.server.ts.';
