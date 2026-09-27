-- Multi-role Telegram notifications: one bot, many recipient chats.
--
-- Replaces the single deployment-wide TELEGRAM_CHAT_ID env var (which sent
-- every agency's limit requests into xRush's own chat — a cross-tenant leak)
-- with per-recipient subscriptions, linked through the bot's /start deep link.
--
-- Recipients are one of three kinds:
--   platform_admin -> one platform admin's own user id
--   agency         -> an organization
--   client         -> a client
--
-- The spec's generic `recipient_id` is kept (it is what dispatch filters on),
-- but a single uuid column cannot be a foreign key to three tables. So each
-- row ALSO carries the matching typed FK column, and a CHECK ties the two
-- together. That gives real referential integrity plus ON DELETE CASCADE, so
-- agency offboarding, "Clear all data" (per-organization DELETE since
-- migration 000032 — no TRUNCATE ... CASCADE left) and client/user deletion
-- clean these rows up with no changes to OFFBOARD_ORDER or WIPE_ORDER.
--
-- RLS is enabled with ZERO policies on all three tables, same as
-- app_settings/platform_settings: chat ids and link tokens are an
-- exfiltration channel for a tenant's data, so they are reachable only
-- through the service-role server layer, after authorization.

-- ---------------------------------------------------------------------------
-- telegram_subscriptions
-- ---------------------------------------------------------------------------
create table public.telegram_subscriptions (
  id uuid primary key default gen_random_uuid(),
  recipient_type text not null
    check (recipient_type in ('platform_admin', 'agency', 'client')),
  recipient_id uuid not null,
  platform_user_id uuid references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete cascade,
  telegram_chat_id text not null,
  telegram_username text,
  -- Group/channel title when linked from a group chat; null for a DM.
  telegram_chat_title text,
  linked_by uuid references auth.users (id) on delete set null,
  linked_at timestamptz not null default now(),
  is_active boolean not null default true,
  unlinked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (recipient_type, recipient_id, telegram_chat_id),
  constraint telegram_subscriptions_recipient_ck check (
    (recipient_type = 'platform_admin'
      and platform_user_id = recipient_id
      and organization_id is null and client_id is null)
    or (recipient_type = 'agency'
      and organization_id = recipient_id
      and platform_user_id is null and client_id is null)
    or (recipient_type = 'client'
      and client_id = recipient_id
      and organization_id is not null and platform_user_id is null)
  )
);

create index idx_telegram_subscriptions_recipient
  on public.telegram_subscriptions (recipient_type, recipient_id)
  where is_active;
create index idx_telegram_subscriptions_chat
  on public.telegram_subscriptions (telegram_chat_id);

alter table public.telegram_subscriptions enable row level security;

-- ---------------------------------------------------------------------------
-- telegram_link_requests — single-use, short-lived /start payloads
-- ---------------------------------------------------------------------------
-- Named telegram_link_REQUESTS, not _tokens: the live project already has an
-- (empty) `telegram_link_tokens` + `user_telegram_links` pair from remote-only
-- migrations 000041-000045, which are not in this repo. This table must not
-- collide with them; whether those two are dropped is the owner's decision.
--
-- Only a SHA-256 hash of the token is stored: the raw token is shown once in
-- the deep link and never persisted, so a read of this table cannot be
-- replayed into a link.
create table public.telegram_link_requests (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  recipient_type text not null
    check (recipient_type in ('platform_admin', 'agency', 'client')),
  recipient_id uuid not null,
  platform_user_id uuid references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.telegram_link_requests enable row level security;

-- ---------------------------------------------------------------------------
-- notification_events — delivery log, so "Telegram stopped working" is a
-- query rather than a mystery.
-- ---------------------------------------------------------------------------
create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  recipient_type text not null
    check (recipient_type in ('platform_admin', 'agency', 'client')),
  recipient_id uuid not null,
  -- The tenant this event belongs to (null for platform-admin events), so an
  -- offboarded agency's delivery history goes with it.
  organization_id uuid references public.organizations (id) on delete cascade,
  subscription_id uuid references public.telegram_subscriptions (id) on delete set null,
  telegram_chat_id text,
  payload jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped_no_subscription')),
  telegram_response jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_notification_events_status_created
  on public.notification_events (status, created_at desc);

alter table public.notification_events enable row level security;
