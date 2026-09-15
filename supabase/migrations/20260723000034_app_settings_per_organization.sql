-- ============================================================================
-- Rush Tracker — app_settings becomes per-organization.
--
-- Rush Tracker is now sold to other agencies (see the multi-tenant migrations
-- 000031–000033). `app_settings` was the one table deliberately left
-- single-tenant at the time, because its only consumer — getMetaConfig() in
-- meta.server.ts — took no parameters, so scoping the table without
-- redesigning the Meta integration's call graph would have produced a
-- Settings screen that looked per-agency and silently wasn't.
--
-- That redesign lands with this migration: every Meta credential is now the
-- property of one organization. xRush Agency (org zero) keeps the credentials
-- configured to date; a new agency starts with nothing and connects its own
-- Business Portfolio from its own Settings screen.
--
-- BACKFILL: the column is added WITH a default of org zero's id, so every
-- existing row (xRush's live Meta credentials) is carried over in one
-- metadata-only statement — "all the credentials shift to xRush Agency".
-- The default is then DROPPED: unlike the 17 tables in migration 000031,
-- this table has exactly one writer (updateIntegrationSettingsFn), which is
-- updated in the same change, so a default would no longer be a safety net —
-- it would be a way for a bug to silently overwrite xRush's live API token
-- with another agency's.
--
-- SECURITY: RLS stays enabled with ZERO policies, unchanged. This table holds
-- live secrets (each agency's Meta System User token) and must only ever be
-- reachable through the service-role server layer.
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   delete from public.app_settings
--     where organization_id <> '00000000-0000-0000-0000-000000000001';
--   alter table public.app_settings drop constraint app_settings_pkey;
--   alter table public.app_settings add constraint app_settings_pkey primary key (key);
--   alter table public.app_settings drop column organization_id;
-- ============================================================================

alter table public.app_settings
  add column organization_id uuid not null
    default '00000000-0000-0000-0000-000000000001'
    references public.organizations (id) on delete cascade;

-- One row per (agency, setting) instead of one row per setting globally.
alter table public.app_settings drop constraint app_settings_pkey;
alter table public.app_settings
  add constraint app_settings_pkey primary key (organization_id, key);

-- See the note above: the writer always supplies this explicitly now.
alter table public.app_settings alter column organization_id drop default;

comment on column public.app_settings.organization_id is
  'Owning agency. Meta credentials are per-organization; the META_* env vars '
  'are a fallback for org zero (the deployment owner) ONLY — see '
  'getMetaConfig() in src/server/meta/meta.server.ts.';
