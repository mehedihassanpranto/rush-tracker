-- ============================================================================
-- Agency-initiated "Request Ad Account" (spec §4.4 of the "Mother Platform
-- Account Control" doc): an agency asks the platform to hand it a NEW
-- platform-managed ad account, e.g. because it has run out of assignable
-- inventory for a new or growing client.
--
-- NAMING — deliberately NOT `ad_account_requests`, which is what the spec calls
-- its one shared table. In this codebase a client's limit request already
-- lives in `limit_requests` (with its own approval RPCs and ledger), so the
-- spec's "one table, three request_types" collapses to: limit requests stay
-- where they are (built as §4.3), and this table holds ONLY the type that had
-- no home yet — agency -> platform, no client and no existing ad account
-- involved. "Account request" was too easy to confuse with a limit request.
--
-- The tenant column is `organization_id` (this codebase's word for the spec's
-- `agencies`/`requesting_agency_id`), and fulfilment reuses
-- platform_account_grants — no new ownership mechanism.
--
-- `status` is text + CHECK rather than an enum type on purpose: a new enum
-- value cannot be used in the transaction that adds it (limit_request_status
-- needed its own standalone migration for exactly that), and there is no
-- benefit to the enum here.
--
-- MANUAL ROLLBACK (no down-migrations in this project):
--   drop table public.platform_account_requests;
--   drop sequence public.platform_account_request_seq;
-- ============================================================================

create sequence if not exists public.platform_account_request_seq;

create table public.platform_account_requests (
  id                      uuid primary key default gen_random_uuid(),
  request_number          text not null unique
                            default ('AAR-' || lpad(nextval('public.platform_account_request_seq')::text, 6, '0')),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  requested_by            uuid references auth.users (id),
  notes                   text not null,
  status                  text not null default 'PENDING'
                            check (status in ('PENDING', 'FULFILLED', 'REJECTED', 'CANCELLED')),
  fulfilled_ad_account_id uuid references public.ad_accounts (id) on delete set null,
  decision_reason         text,
  decided_by              uuid references auth.users (id),
  decided_at              timestamptz,
  cancelled_at            timestamptz,
  created_at              timestamptz not null default now(),
  -- Only a fulfilled request may name an account. The reverse (fulfilled =>
  -- named) is deliberately not enforced: the account can be deleted later and
  -- on delete set null must not be blocked by this constraint.
  constraint platform_account_requests_fulfilled_ck check (
    fulfilled_ad_account_id is null or status = 'FULFILLED'
  )
);

create index idx_platform_account_requests_org
  on public.platform_account_requests (organization_id, created_at desc);
create index idx_platform_account_requests_pending
  on public.platform_account_requests (created_at) where status = 'PENDING';

alter table public.platform_account_requests enable row level security;

-- SELECT-only for authenticated, same convention as every other table here
-- (writes go through the service-role server layer after authorization).
-- An agency sees its own requests; the platform admin sees all.
create policy platform_account_requests_select on public.platform_account_requests
  for select to authenticated
  using (
    (
      organization_id = public.current_org_id()
      and public.is_org_active(organization_id)
    )
    or public.is_platform_admin()
  );
