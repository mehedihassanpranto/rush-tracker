-- ============================================================================
-- Rate limiting for sign-in, 2FA codes and password-reset emails.
--
-- Supabase Auth rate-limits per IP, but every sign-in here is made by the
-- app's SERVER (loginFn), so Supabase sees one IP for all users: its limits
-- neither stop a password-guessing attacker nor protect anyone from being
-- locked out by one. This table lets the server limit by the real client IP
-- and, more importantly, by the account being targeted.
--
-- kind:        'login' | 'mfa' | 'reset'
-- identifier:  lowercased email (login/reset) or user id (mfa)
-- ip:          client IP as seen by the app (last X-Forwarded-For hop)
--
-- RLS on, zero policies (service-role server layer only), no FKs (attempts
-- against non-existent accounts must be recordable too). Pruned to 7 days by
-- the daily cron.
-- ============================================================================

create table public.auth_attempts (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('login', 'mfa', 'reset')),
  identifier    text not null,
  ip            text,
  success       boolean not null,
  attempted_at  timestamptz not null default now()
);
create index idx_auth_attempts_identifier on public.auth_attempts (kind, identifier, attempted_at desc);
create index idx_auth_attempts_ip on public.auth_attempts (kind, ip, attempted_at desc);
alter table public.auth_attempts enable row level security;
