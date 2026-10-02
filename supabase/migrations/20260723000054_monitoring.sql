-- ============================================================================
-- Monitoring (upgrade plan step 5): know when the background job stops, when a
-- Meta token is about to die, and when server code throws.
--
-- Until now the only evidence the daily Meta sync ran was indirect (a digest
-- notification that is only sent when there is something to report). Moving
-- production from Vercel to Hostinger showed how easy it is for that job to
-- stop without anyone noticing.
--
-- * cron_runs — one row per scheduled-job run: start, finish, outcome, a JSON
--   summary. "Stale" (no successful run recently) is derived from it.
-- * integration_health — latest Meta token check per credential set
--   ('platform' or 'org:<uuid>'): valid?, expiry, last error.
-- * app_errors — server-function and cron errors (message, stack, which fn,
--   who). Pruned to 30 days by the cron.
--
-- All three: RLS on, zero policies — only the service-role server layer reads
-- or writes them (the platform's System Health page is requirePlatformAdmin).
-- Deliberately NO foreign keys: a log write must never fail because a user or
-- agency was deleted, and log rows should outlive what they describe.
-- ============================================================================

create table public.cron_runs (
  id           uuid primary key default gen_random_uuid(),
  job          text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running'
               check (status in ('running', 'success', 'partial', 'failed')),
  summary      jsonb,
  error        text
);
create index idx_cron_runs_job_started on public.cron_runs (job, started_at desc);
alter table public.cron_runs enable row level security;

create table public.integration_health (
  scope_key               text primary key,
  provider                text not null default 'meta',
  checked_at              timestamptz not null default now(),
  configured              boolean not null,
  valid                   boolean,
  expires_at              timestamptz,
  data_access_expires_at  timestamptz,
  error                   text,
  -- last state we alerted on, so the cron alerts once per change rather than
  -- every day the token stays broken
  alerted_state           text
);
alter table public.integration_health enable row level security;

create table public.app_errors (
  id               uuid primary key default gen_random_uuid(),
  occurred_at      timestamptz not null default now(),
  source           text not null,          -- 'server_fn' | 'cron'
  name             text,
  message          text not null,
  stack            text,
  fn_name          text,
  fn_file          text,
  user_id          uuid,
  organization_id  uuid
);
create index idx_app_errors_occurred on public.app_errors (occurred_at desc);
alter table public.app_errors enable row level security;
