-- ============================================================================
-- Rush Tracker — platform-owned ad account pool.
--
-- Until now every ad account belonged to exactly one agency (organization_id,
-- NOT NULL since migration 000031). This adds a second ownership model: the
-- PLATFORM (the vendor layer behind /platform, not a customer) can own a pool
-- of ad accounts and grant individual accounts to specific agencies. An
-- agency's accounts become the union of what they connected themselves and
-- what has been granted to them.
--
-- The agency-connects-their-own-Meta-credentials flow is untouched.
--
-- NAMING — deliberate, do not "tidy" this later:
--   ad_account_assignments  = ad account -> CLIENT   (existing, Phase 2, the
--                             assign/release/transfer feature with its own
--                             RPCs, history UI and ledger interaction)
--   platform_account_grants = ad account -> AGENCY   (new, this migration)
-- Two different relationships on the same account. The verbs are kept
-- distinct ("assign" vs "grant") so they can never be confused in code,
-- conversation, or the audit trail.
--
-- CREDENTIALS: there is no credential row to re-tag. Agency credentials live
-- in app_settings keyed by (organization_id, key); the platform's own
-- credential is the deployment's META_* environment variables, which already
-- point at the pool's Business Portfolio. See getMetaConfig() in
-- src/server/meta/meta.server.ts — a platform-owned account resolves its
-- token from the env vars, an agency-owned one from that agency's rows.
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   update public.ad_accounts set organization_id =
--     '00000000-0000-0000-0000-000000000001', is_platform = false
--     where is_platform;
--   drop table public.platform_account_grants;
--   alter table public.ad_accounts drop constraint ad_accounts_ownership_ck;
--   alter table public.ad_accounts drop column is_platform;
--   alter table public.ad_accounts alter column organization_id set not null;
-- ============================================================================

alter table public.ad_accounts
  add column is_platform boolean not null default false;

-- Platform-owned accounts have no owning agency; agency-owned ones must.
alter table public.ad_accounts alter column organization_id drop not null;

alter table public.ad_accounts
  add constraint ad_accounts_ownership_ck check (
    (is_platform and organization_id is null)
    or (not is_platform and organization_id is not null)
  );

create index idx_ad_accounts_is_platform
  on public.ad_accounts (is_platform) where is_platform;

-- ----------------------------------------------------------------------------
-- platform_account_grants — which agency may currently use a pool account.
-- UNIQUE on ad_account_id: one agency at a time per account, enforced by the
-- database rather than by application code.
-- ----------------------------------------------------------------------------
create table public.platform_account_grants (
  id              uuid primary key default gen_random_uuid(),
  ad_account_id   uuid not null unique references public.ad_accounts (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  granted_at      timestamptz not null default now(),
  granted_by      uuid references auth.users (id)
);

create index idx_platform_account_grants_organization
  on public.platform_account_grants (organization_id);

alter table public.platform_account_grants enable row level security;

-- SELECT-only for authenticated, same convention as every other table here
-- (writes go through the service-role server layer after authorization).
-- An agency may see its own grants; the platform admin sees all.
create policy platform_account_grants_select on public.platform_account_grants
  for select to authenticated
  using (
    (
      organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );

-- ----------------------------------------------------------------------------
-- Re-tag xRush Agency's existing accounts into the pool, then grant them all
-- straight back to xRush, so its day-to-day access is unchanged end-to-end.
-- Confirmed with the owner before writing this: all 34 of org zero's accounts
-- move (18 currently held by its clients, 16 available).
-- ----------------------------------------------------------------------------
insert into public.platform_account_grants (ad_account_id, organization_id)
select id, organization_id
  from public.ad_accounts
 where organization_id = '00000000-0000-0000-0000-000000000001';

update public.ad_accounts
   set is_platform = true, organization_id = null
 where organization_id = '00000000-0000-0000-0000-000000000001';

-- ----------------------------------------------------------------------------
-- RLS: ad_accounts_select gated on `organization_id = current_org_id()`, which
-- is NULL for every pool account — so without this an agency would lose RLS
-- visibility of accounts granted to it. Adds the granted-account arm.
-- (RLS is defense-in-depth here; the server layer is the real boundary.)
-- ----------------------------------------------------------------------------
alter policy ad_accounts_select on public.ad_accounts
  using (
    (
      (
        public.is_admin()
        or exists (
          select 1 from public.ad_account_assignments a
          where a.ad_account_id = ad_accounts.id
            and a.status = 'ACTIVE'
            and public.is_client_member(a.client_id)
        )
      )
      and (
        (
          organization_id = public.current_org_id()
          and public.is_org_active(organization_id)
        )
        or exists (
          select 1 from public.platform_account_grants g
          where g.ad_account_id = ad_accounts.id
            and g.organization_id = public.current_org_id()
            and public.is_org_active(g.organization_id)
        )
      )
    )
    or public.is_platform_admin()
  );
